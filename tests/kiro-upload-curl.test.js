import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { jest } from '@jest/globals';
import { sendCurl } from '../src/scripts/kiro-upload-curl.mjs';

const target = new URL('https://example.invalid/generateAssistantResponse');
const payload = Buffer.from('binary\0request 中文');
const authorization = 'Bearer test-access-token-with-private-value';
const headers = { Authorization: authorization, 'Content-Type': 'application/json',
    'Content-Encoding': 'gzip', 'Content-Length': String(payload.length) };

function fakeCurl() {
    const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: jest.fn()
    });
    const input = [];
    child.stdin.on('data', chunk => input.push(chunk));
    let command, argv, options, configPath, config, responseHeaderPath;
    const spawnImpl = jest.fn((name, args, settings) => {
        command = name; argv = args; options = settings;
        configPath = args[args.indexOf('--config') + 1];
        responseHeaderPath = args[args.indexOf('--dump-header') + 1];
        config = fs.readFileSync(configPath, 'utf8');
        return child;
    });
    return { child, spawnImpl, input, get command() { return command; }, get argv() { return argv; },
        get options() { return options; }, get configPath() { return configPath; }, get config() { return config; },
        get responseHeaderPath() { return responseHeaderPath; } };
}

function reply(fake, { status = 400, text = '{"message":"invalid effort"}', timing = '0.125' } = {}) {
    fs.appendFileSync(fake.responseHeaderPath, `HTTP/1.1 ${status} Test\r\nContent-Type: application/json\r\nx-amzn-errortype: ValidationException\r\n\r\n`);
    fake.child.stdout.write(text);
    fake.child.stderr.write(`\n__KIRO_PROBE_TTFB__${timing}\n`);
    fake.child.emit('close', 0);
}

test('keeps credentials out of argv, sends exact stdin bytes, and removes private config before returning', async () => {
    const fake = fakeCurl();
    const proxy = new URL('socks5://private-user:private-password@127.0.0.1:1080');
    const pending = sendCurl(target, headers, payload, { proxy, spawnImpl: fake.spawnImpl });
    expect(fake.command).toBe('curl');
    expect(fake.options).toEqual({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(fake.argv.join(' ')).not.toMatch(/test-access-token|private-user|private-password/);
    expect(fake.config).toContain(authorization);
    expect(fake.config).toContain('proxy = "socks5://private-user:private-password@127.0.0.1:1080"');
    expect(fake.config).toContain('noproxy = ""');
    expect(fake.config).toContain('header = "Expect:"');
    expect(fake.config).toContain('header = "Content-Encoding: gzip"');
    expect(fs.statSync(fake.configPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(fake.configPath)).mode & 0o777).toBe(0o700);
    expect(fake.argv[0]).toBe('--disable');
    expect(fake.argv).toEqual(expect.arrayContaining(['--http1.1', '--proto', '=https', '--retry', '0',
        '--suppress-connect-headers', '--no-buffer', '--data-binary', '@-']));
    expect(fake.argv).not.toContain('--compressed');
    reply(fake);
    const result = await pending;
    expect(Buffer.concat(fake.input)).toEqual(payload);
    expect(result).toMatchObject({ status: 400, headers: { 'x-amzn-errortype': 'ValidationException' },
        text: '{"message":"invalid effort"}', ttfbMs: 125, writeMs: null, reusedSocket: false });
    expect(result.error).toBeUndefined();
    expect(fs.existsSync(path.dirname(fake.configPath))).toBe(false);
});

test.each(['http', 'https', 'socks5', 'socks5h'])('supports an explicit %s proxy without exposing its password in arguments', async scheme => {
    const fake = fakeCurl();
    const pending = sendCurl(target, headers, payload, { proxy: `${scheme}://name:secret@127.0.0.1:1080`, spawnImpl: fake.spawnImpl });
    expect(fake.config).toContain(`proxy = "${scheme}://name:secret@127.0.0.1:1080"`);
    expect(fake.argv.join(' ')).not.toContain('secret');
    reply(fake);
    await pending;
});

test('direct mode disables environment proxies and safely escapes config values', async () => {
    const fake = fakeCurl();
    const pending = sendCurl(target, { ...headers, 'x-test': 'a"b\\c' }, payload,
        { caFile: '/tmp/ca file.pem', spawnImpl: fake.spawnImpl });
    expect(fake.config).toContain('noproxy = "*"');
    expect(fake.config).toContain('cacert = "/tmp/ca file.pem"');
    expect(fake.config).toContain('header = "x-test: a\\"b\\\\c"');
    expect(fake.config).not.toContain('\nproxy =');
    reply(fake);
    await pending;
});

test('parses split headers and skips informational replies before classifying the final response', async () => {
    const fake = fakeCurl();
    const pending = sendCurl(target, headers, payload, { spawnImpl: fake.spawnImpl });
    fs.appendFileSync(fake.responseHeaderPath, 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </test>\r\n\r\nHTTP/1.1 400');
    fs.appendFileSync(fake.responseHeaderPath, ' Bad Request\r\nX-Amzn-Errortype: SerializationException\r\n\r\n');
    fake.child.stdout.write('invalid');
    fake.child.emit('close', 0);
    expect(await pending).toMatchObject({ status: 400, text: 'invalid', headers: { 'x-amzn-errortype': 'SerializationException' } });
    expect(fake.child.kill).not.toHaveBeenCalled();
});

test.each([200, 201, 204, 299])('kills curl immediately at upstream HTTP %i and cleans credentials before resolving', async status => {
    const fake = fakeCurl();
    const pending = sendCurl(target, headers, payload, { spawnImpl: fake.spawnImpl });
    fs.appendFileSync(fake.responseHeaderPath, `HTTP/1.1 ${status} Success\r\nContent-Type: application/vnd.amazon.eventstream\r\n\r\n`);
    const result = await pending;
    expect(result).toMatchObject({ status, unsafe: true, text: '' });
    expect(fake.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fs.existsSync(path.dirname(fake.configPath))).toBe(false);
});

test('a missing curl returns only a safe error and removes the temporary credentials', async () => {
    const fake = fakeCurl();
    const pending = sendCurl(target, headers, payload, { spawnImpl: fake.spawnImpl });
    fake.child.emit('error', Object.assign(new Error(`failure with ${authorization}`), { code: 'ENOENT' }));
    const result = await pending;
    expect(result.error.code).toBe('CURL_UNAVAILABLE');
    expect(result.error.message).not.toContain(authorization);
    expect(fs.existsSync(path.dirname(fake.configPath))).toBe(false);
});

test.each([28, 56])('maps curl exit %i without exposing its stderr', async code => {
    const fake = fakeCurl();
    const pending = sendCurl(target, headers, payload, { spawnImpl: fake.spawnImpl });
    fake.child.stderr.write(`Failed proxy socks5://private-user:private-password@host; ${authorization}`);
    fake.child.emit('close', code);
    const result = await pending;
    expect(result.error.code).toBe(code === 28 ? 'ETIMEDOUT' : `CURL_EXIT_${code}`);
    expect(result.error.message).not.toMatch(/private-user|private-password|test-access-token/);
    expect(fs.existsSync(path.dirname(fake.configPath))).toBe(false);
});

test('the wall-clock deadline kills a stalled curl process and removes credentials', async () => {
    const fake = fakeCurl();
    const result = await sendCurl(target, headers, payload, { timeoutMs: 20, spawnImpl: fake.spawnImpl });
    expect(result.error.code).toBe('ETIMEDOUT');
    expect(fake.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fs.existsSync(path.dirname(fake.configPath))).toBe(false);
}, 1000);

test('retains at most 8192 response bytes', async () => {
    const fake = fakeCurl();
    const pending = sendCurl(target, headers, payload, { spawnImpl: fake.spawnImpl });
    reply(fake, { text: 'x'.repeat(100000) });
    expect((await pending).text).toHaveLength(8192);
});

test('rejects invalid headers before starting curl', async () => {
    const fake = fakeCurl();
    const result = await sendCurl(target, { Authorization: 'token\r\ninjected: value' }, payload, { spawnImpl: fake.spawnImpl });
    expect(result.error.code).toBe('CURL_CONFIG_ERROR');
    expect(fake.spawnImpl).not.toHaveBeenCalled();
});

test('synchronous spawn failures never return sensitive exception text', async () => {
    const result = await sendCurl(target, headers, payload, { spawnImpl: () => { throw new Error(authorization); } });
    expect(result.error.code).toBe('CURL_CONFIG_ERROR');
    expect(result.error.message).not.toContain(authorization);
});
