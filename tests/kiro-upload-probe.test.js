import { jest } from '@jest/globals';
import { EventEmitter, getEventListeners } from 'node:events';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import {
    classifyGzipPair, createAgent, describeReply, encode, headersFor, isEffortRejection,
    makeBody, resolveProxy, send, summarizeGzipChecks, tunnel
} from '../src/scripts/kiro-upload-probe.mjs';

const agents = new Set();
const proxy = 'http://127.0.0.1:7890';
const target = new URL('https://example.invalid/generateAssistantResponse');
const fakeSocket = () => {
    const socket = new EventEmitter();
    socket.write = jest.fn(() => true);
    socket.pause = jest.fn();
    socket.unshift = jest.fn();
    socket.destroy = jest.fn(() => { socket.destroyed = true; return socket; });
    return socket;
};
const setupTransport = (proxyUrl = proxy) => {
    const raw = fakeSocket(), secure = fakeSocket();
    const transport = {
        connect: jest.fn(() => raw),
        connectTls: jest.fn(options => options.socket ? secure : raw)
    };
    const agent = createAgent(new URL(proxyUrl), transport);
    agents.add(agent);
    return { raw, secure, transport, agent };
};
const connectedTunnel = raw => {
    raw.emit('connect');
    raw.emit('data', Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'));
};

afterEach(() => {
    for (const agent of agents) agent.destroy();
    agents.clear();
    jest.restoreAllMocks();
    jest.useRealTimers();
});

test.each([
    [{ NODE_PROXY_URL: proxy }, {}, proxy],
    [{ KIRO_SIDECAR_PROXY_URL: 'http://127.0.0.1:8000' }, { KIRO_SIDECAR_PROXY_URL: proxy }, proxy],
    [{ PROXY_URL: 'http://127.0.0.1:8000' }, { PROXY_URL: proxy }, proxy],
    [{ KIRO_SIDECAR_PROXY_URL: proxy }, { NODE_PROXY_URL: 'http://127.0.0.1:8001' }, 'http://127.0.0.1:8001'],
    [{ KIRO_SIDECAR_PROXY_URL: proxy }, { KIRO_SIDECAR_PROXY_URL: null, PROXY_URL: null }, null]
])('uses the production route after merging global %p and account %p', (config, node, expected) => {
    expect(resolveProxy({ proxy: null }, { config, node })?.href || null)
        .toBe(expected ? `${expected}/` : null);
});

test('resolves account bindings with the merged account identity and preserves explicit overrides', () => {
    const getProxyUrl = jest.fn(() => proxy);
    const account = { config: { ipNodeProxy: { getProxyUrl }, PROXY_URL: 'http://127.0.0.1:8000' }, node: { uuid: 'account-a' } };
    expect(resolveProxy({ proxy: null }, account).href).toBe(`${proxy}/`);
    expect(getProxyUrl).toHaveBeenCalledWith('claude-kiro-oauth', 'account-a');
    getProxyUrl.mockClear();
    expect(resolveProxy({ proxy: 'none' }, account)).toBeNull();
    expect(resolveProxy({ proxy: 'https://127.0.0.1:8002' }, account).href).toBe('https://127.0.0.1:8002/');
    expect(getProxyUrl).not.toHaveBeenCalled();
});

test.each(['tcp', 'connect', 'target-tls', 'proxy-tls'])('the total deadline closes a stalled %s phase before an Agent socket exists', async phase => {
    const { raw, secure, agent } = setupTransport(phase === 'proxy-tls' ? 'https://127.0.0.1:7890' : proxy);
    const pending = send(agent, target, {}, Buffer.from('{}'), { timeoutMs: 20 });
    if (phase === 'connect') raw.emit('connect');
    if (phase === 'target-tls') connectedTunnel(raw);
    const result = await pending;
    expect(result.error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    if (phase === 'target-tls') expect(secure.destroy).toHaveBeenCalledTimes(1);
    expect(raw.listenerCount('data')).toBe(0);
    expect(raw.listenerCount('close')).toBe(0);
    expect(() => raw.emit('error', new Error('late connection failure'))).not.toThrow();
    if (phase === 'target-tls') expect(() => secure.emit('error', new Error('late TLS failure'))).not.toThrow();
}, 1000);

test.each(['end', 'close', 'error'])('a proxy %s during CONNECT promptly fails and releases its socket', async event => {
    const { raw, agent } = setupTransport();
    const pending = send(agent, target, {}, Buffer.from('{}'), { timeoutMs: 1000 });
    raw.emit('connect');
    raw.emit(event, new Error('simulated proxy failure'));
    const result = await pending;
    expect(result.error.message).toMatch(/closed|simulated proxy failure/);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(raw.listenerCount('data')).toBe(0);
}, 500);

test.each(['raw', 'secure'])('an early %s close during target TLS destroys both tunnel sockets', async which => {
    const { raw, secure, agent } = setupTransport();
    const pending = send(agent, target, {}, Buffer.from('{}'), { timeoutMs: 1000 });
    connectedTunnel(raw);
    (which === 'raw' ? raw : secure).emit('close');
    expect((await pending).error.message).toMatch(/closed/);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(secure.destroy).toHaveBeenCalledTimes(1);
}, 500);

test('successful TLS hands ownership to the request and removes the tunnel cancellation listener', () => {
    const { raw, secure, transport } = setupTransport();
    const controller = new AbortController(), callback = jest.fn();
    tunnel(new URL(proxy), { host: target.hostname, kiroProbeSignal: controller.signal }, callback, transport);
    connectedTunnel(raw);
    secure.emit('secureConnect');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null, secure);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    controller.abort();
    expect(raw.destroy).not.toHaveBeenCalled();
    expect(secure.destroy).not.toHaveBeenCalled();
});

test('a synchronous target TLS failure closes the proxy socket and removes cancellation state', () => {
    const { raw, transport } = setupTransport();
    const controller = new AbortController(), callback = jest.fn();
    const failure = new Error('invalid TLS options');
    transport.connectTls.mockImplementation(() => { throw failure; });
    tunnel(new URL(proxy), { host: target.hostname, kiroProbeSignal: controller.signal }, callback, transport);
    expect(() => connectedTunnel(raw)).not.toThrow();
    expect(callback).toHaveBeenCalledWith(failure, undefined);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(() => raw.emit('error', new Error('late proxy failure'))).not.toThrow();
});

const fakeRequest = () => {
    const req = new EventEmitter();
    req.destroy = jest.fn();
    req.end = jest.fn((payload, callback) => callback());
    return req;
};

test.each(['request', 'end'])('a synchronous %s failure cancels transport work and clears the deadline', async phase => {
    jest.useFakeTimers();
    const req = fakeRequest(), failure = new Error('invalid request');
    let signal;
    jest.spyOn(https, 'request').mockImplementation((url, options) => {
        signal = options.kiroProbeSignal;
        if (phase === 'request') throw failure;
        req.end.mockImplementation(() => { throw failure; });
        return req;
    });
    expect((await send({}, target, {}, Buffer.from('{}'))).error).toBe(failure);
    expect(signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    if (phase === 'end') expect(req.destroy).toHaveBeenCalledTimes(1);
});

test('invalid HTTP headers fail before transport creation without leaving a deadline behind', async () => {
    jest.useFakeTimers();
    const { agent, transport } = setupTransport();
    const result = await send(agent, target, { 'x-probe': undefined }, Buffer.from('{}'));
    expect(result.error).toMatchObject({ code: 'ERR_HTTP_INVALID_HEADER_VALUE' });
    expect(transport.connect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
});

test('the same total deadline also terminates a stalled response body', async () => {
    jest.useFakeTimers();
    const req = fakeRequest(), res = Object.assign(new EventEmitter(), { statusCode: 400, headers: {}, destroy: jest.fn() });
    let respond;
    jest.spyOn(https, 'request').mockImplementation((url, options, callback) => { respond = callback; return req; });
    const pending = send({}, target, {}, Buffer.from('{}'), { timeoutMs: 20 });
    respond(res);
    res.emit('data', Buffer.from('{"message":'));
    await jest.advanceTimersByTimeAsync(20);
    expect((await pending).error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(req.destroy).toHaveBeenCalledTimes(1);
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
});

test('completed replies clear their deadline and retain their response body', async () => {
    jest.useFakeTimers();
    const req = fakeRequest(), res = Object.assign(new EventEmitter(), { statusCode: 400, headers: {} });
    let respond;
    jest.spyOn(https, 'request').mockImplementation((url, options, callback) => { respond = callback; return req; });
    const pending = send({}, target, {}, Buffer.from('{}'), { timeoutMs: 20 });
    respond(res);
    res.emit('data', Buffer.from('{"message":"invalid effort"}'));
    res.emit('end');
    res.emit('close');
    expect(await pending).toMatchObject({ status: 400, text: '{"message":"invalid effort"}' });
    expect(jest.getTimerCount()).toBe(0);
    expect(req.destroy).not.toHaveBeenCalled();
});

test('the CLI entry point still prints help without reading credentials or sending a request', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const output = execFileSync(process.execPath, ['src/scripts/kiro-upload-probe.mjs', '--help'], { cwd: root, encoding: 'utf8' });
    expect(output).toContain('Usage: node src/scripts/kiro-upload-probe.mjs');
    expect(output).toContain('--proxy <url|none>');
    expect(output).toContain('--client <node|curl|both>');
    expect(output).toContain('--check-only');
});

describe('paired request-gzip diagnostics', () => {
    const enumMessage = 'Invalid additionalModelRequestFields: does not have a value in the enumeration ["low", "medium", "high", "xhigh", "max"]';
    const sample = (status = 400, type = 'ValidationException', message = enumMessage) => {
        const reply = describeReply({ status, headers: { 'x-amzn-errortype': type }, text: JSON.stringify({ message }) });
        return { status, reply: reply.text, replyType: reply.type, replyMessage: reply.message, jsonSha256: 'same-json', transportError: false };
    };

    test('plain and gzip reuse identical JSON and conversation IDs across requests', () => {
        const body = makeBody({ label: '1k', bytes: 1000 }, 0, 'claude-opus-5.5');
        const first = encode(body, false), compressed = encode(body, true), again = encode(body, false);
        expect(first.payload).toEqual(again.payload);
        expect(gunzipSync(compressed.payload)).toEqual(first.payload);
        expect(compressed.json).toEqual(first.json);
        expect(createHash('sha256').update(first.json).digest('hex')).toBe(body.jsonSha256);
        const headers = headersFor('mock-only', compressed.payload, true);
        expect(headers['Content-Encoding']).toBe('gzip');
        expect(Number(headers['Content-Length'])).toBe(compressed.payload.length);
        expect(JSON.parse(first.json).additionalModelRequestFields.output_config.effort).toBe('probe-invalid-effort');
    });

    test('recognizes the actual enum error even when it does not name effort', () => {
        expect(isEffortRejection(sample())).toBe(true);
        expect(classifyGzipPair(sample(), sample())).toMatchObject({ verdict: 'supported' });
    });

    test('uses JSON __type when the AWS error-type header is absent', () => {
        const reply = describeReply({ status: 400, headers: {}, text: JSON.stringify({ __type: 'service#ValidationException', message: enumMessage }) });
        expect(isEffortRejection({ status: 400, replyType: reply.type, replyMessage: reply.message })).toBe(true);
    });

    test('does not treat matching arbitrary HTTP 400 replies as gzip support', () => {
        const generic = sample(400, 'SerializationException', 'Improperly formed request.');
        expect(classifyGzipPair(generic, generic)).toMatchObject({ verdict: 'inconclusive' });
    });

    test.each([
        [400, 'SerializationException'], [400, 'UnsupportedContentEncoding'], [415, 'UnsupportedMediaType']
    ])('reports explicit gzip parsing/encoding rejection for %i %s', (status, type) => {
        expect(classifyGzipPair(sample(), sample(status, type, 'Improperly formed request.'))).toMatchObject({ verdict: 'rejected' });
    });

    test.each([401, 403, 413, 429, 500, 503])('does not misclassify gzip HTTP %i as no compression support', status => {
        expect(classifyGzipPair(sample(), sample(status, 'OtherError', 'upstream policy error'))).toMatchObject({ verdict: 'inconclusive' });
    });

    test('transport errors and changed JSON cannot establish support', () => {
        expect(classifyGzipPair(sample(), { ...sample(), status: null, transportError: true })).toMatchObject({ verdict: 'inconclusive' });
        expect(classifyGzipPair(sample(), { ...sample(), jsonSha256: 'different-json' })).toMatchObject({ verdict: 'inconclusive' });
    });

    test('distinguishes size and client disagreements instead of flattening them to false', () => {
        const sizeDependent = summarizeGzipChecks([
            { client: 'node', size: '1k', verdict: 'rejected' },
            { client: 'node', size: '900k', verdict: 'supported' }
        ]);
        expect(sizeDependent).toMatchObject({ gzipAccepted: null, gzipVerdict: 'mixed', sizeDependent: true, clientDependent: false });
        const clientDependent = summarizeGzipChecks([
            { client: 'node', size: '1k', verdict: 'rejected' },
            { client: 'curl', size: '1k', verdict: 'supported' }
        ]);
        expect(clientDependent).toMatchObject({ gzipAccepted: null, gzipVerdict: 'mixed', clientDependent: true, independentAgreement: false });
    });

    test('requires both clients to agree for every size before claiming independent agreement', () => {
        const checks = ['node', 'curl'].flatMap(client => ['1k', '900k'].map(size => ({ client, size, verdict: 'rejected' })));
        expect(summarizeGzipChecks(checks)).toMatchObject({ gzipAccepted: false, gzipVerdict: 'rejected', independentAgreement: true });
        expect(summarizeGzipChecks(checks.slice(0, -1)).independentAgreement).toBe(false);
        expect(summarizeGzipChecks([...checks, { client: 'curl', size: '450k', verdict: 'inconclusive' }]))
            .toMatchObject({ gzipAccepted: null, gzipVerdict: 'inconclusive', independentAgreement: false });
    });
});

// ---- SOCKS5 (the kiro-sidecar sends socks5:// and socks5h:// proxies through reqwest) ----

const flush = () => new Promise(resolve => setImmediate(resolve));
const socksTransport = lookup => {
    const raw = fakeSocket(), secure = fakeSocket();
    const transport = {
        connect: jest.fn(() => raw),
        connectTls: jest.fn(options => options.socket ? secure : raw),
        lookup: lookup || jest.fn(async () => ({ address: '203.0.113.7', family: 4 }))
    };
    return { raw, secure, transport };
};
const kiroTarget = { host: 'q.us-east-1.amazonaws.com', port: 443 };
const socksOk = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);

test.each(['socks5://127.0.0.1:1080', 'socks5h://127.0.0.1:1080'])('accepts %s from the production proxy route', value => {
    expect(resolveProxy({ proxy: null }, { config: { PROXY_URL: value }, node: {} }).protocol).toBe(value.split('//')[0]);
});

test('socks5h sends the host name to the proxy, handles split replies and keeps extra bytes for TLS', async () => {
    const { raw, secure, transport } = socksTransport();
    const callback = jest.fn();
    tunnel(new URL('socks5h://127.0.0.1:1080'), { ...kiroTarget }, callback, transport);
    await flush();
    expect(transport.lookup).not.toHaveBeenCalled();
    expect(transport.connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 1080 });
    raw.emit('connect');
    expect(raw.write).toHaveBeenLastCalledWith(Buffer.from([5, 1, 0]));
    raw.emit('data', Buffer.from([5]));
    raw.emit('data', Buffer.from([0]));
    const name = Buffer.from(kiroTarget.host);
    expect(raw.write).toHaveBeenLastCalledWith(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([1, 187])]));
    const extra = Buffer.from([0x16, 3, 1]);
    raw.emit('data', socksOk.subarray(0, 3));
    raw.emit('data', Buffer.concat([socksOk.subarray(3), extra]));
    expect(raw.pause).toHaveBeenCalled();
    expect(raw.unshift).toHaveBeenCalledWith(extra);
    expect(transport.connectTls).toHaveBeenCalledWith({ socket: raw, servername: kiroTarget.host });
    secure.emit('secureConnect');
    expect(callback).toHaveBeenCalledWith(null, secure);
    expect(raw.listenerCount('data')).toBe(0);
});

test('socks5 resolves the host locally and sends decoded username/password credentials', async () => {
    const { raw, transport } = socksTransport();
    tunnel(new URL('socks5://u%40x:p%3Aw@127.0.0.1:7891'), { ...kiroTarget }, jest.fn(), transport);
    await flush();
    expect(transport.lookup).toHaveBeenCalledWith(kiroTarget.host, { family: 4 });
    expect(transport.connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 7891 });
    raw.emit('connect');
    expect(raw.write).toHaveBeenLastCalledWith(Buffer.from([5, 2, 0, 2]));
    raw.emit('data', Buffer.from([5, 2]));
    expect(raw.write).toHaveBeenLastCalledWith(Buffer.from([1, 3, ...Buffer.from('u@x'), 3, ...Buffer.from('p:w')]));
    raw.emit('data', Buffer.from([1, 0]));
    expect(raw.write).toHaveBeenLastCalledWith(Buffer.from([5, 1, 0, 1, 203, 0, 113, 7, 1, 187]));
});

test.each([
    ['a refused CONNECT', [Buffer.from([5, 0]), Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])], /connection refused/],
    ['no acceptable auth method', [Buffer.from([5, 0xff])], /none of the offered auth methods/],
    ['a non-SOCKS5 reply', [Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n')], /did not answer as SOCKS5/]
])('%s fails the tunnel and closes the proxy socket', async (name, replies, message) => {
    const { raw, transport } = socksTransport();
    const callback = jest.fn();
    tunnel(new URL('socks5h://127.0.0.1:1080'), { ...kiroTarget }, callback, transport);
    await flush();
    raw.emit('connect');
    for (const reply of replies) raw.emit('data', reply);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].message).toMatch(message);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(transport.connectTls).not.toHaveBeenCalled();
});

test('rejected SOCKS credentials fail without starting TLS', async () => {
    const { raw, transport } = socksTransport();
    const callback = jest.fn();
    tunnel(new URL('socks5h://user:wrong@127.0.0.1:1080'), { ...kiroTarget }, callback, transport);
    await flush();
    raw.emit('connect');
    raw.emit('data', Buffer.from([5, 2, 1, 1]));
    expect(callback.mock.calls[0][0].message).toMatch(/rejected the username\/password/);
    expect(transport.connectTls).not.toHaveBeenCalled();
});

test('cancellation during the local DNS wait never opens the proxy connection', async () => {
    let resolveLookup;
    const lookup = jest.fn(() => new Promise(resolve => { resolveLookup = resolve; }));
    const { transport } = socksTransport(lookup);
    const controller = new AbortController(), callback = jest.fn();
    tunnel(new URL('socks5://127.0.0.1:1080'), { ...kiroTarget, kiroProbeSignal: controller.signal }, callback, transport);
    controller.abort(new Error('deadline'));
    resolveLookup({ address: '203.0.113.7', family: 4 });
    await flush();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].message).toBe('deadline');
    expect(transport.connect).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

test('a failed local DNS lookup is reported without opening the proxy connection', async () => {
    const { transport } = socksTransport(jest.fn(async () => { throw new Error('ENOTFOUND'); }));
    const callback = jest.fn();
    tunnel(new URL('socks5://127.0.0.1:1080'), { ...kiroTarget }, callback, transport);
    await flush();
    expect(callback.mock.calls[0][0].message).toMatch(/cannot resolve q\.us-east-1\.amazonaws\.com.*ENOTFOUND/);
    expect(transport.connect).not.toHaveBeenCalled();
});
