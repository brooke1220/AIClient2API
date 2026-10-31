import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import axios from 'axios';
import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import KiroSidecar, { getKiroSidecar, getKiroSidecarTargetOrigins } from '../src/utils/kiro-sidecar.js';
import { createFixture, binary, freePort, waitFor, readBody, localRequest, listen } from './helpers/kiro-sidecar-fixture.js';
import { service, collect, frame, text, request, model } from './helpers/kiro-safety-fixtures.js';

let fixture, sidecar;
const managers = new Set();
const agents = new Set();
const frames = () => Buffer.concat([text('你好'), text('你好'), frame('toolUseEvent', {
    toolUseId: 'tool-1', name: 'Read', input: '{"path":"/tmp/报告"}', stop: true,
}), frame('metadataEvent', { stopReason: 'tool_use', usage: { inputTokens: 12, outputTokens: 8 } })]);

beforeAll(async () => { fixture = await createFixture(); }, 120000);
beforeEach(async () => {
    fixture.requests.length = 0;
    fixture.connects.length = 0;
    fixture.proxyAuth = true;
    fixture.handler = (_req, res) => res.end(frames());
    sidecar = await fixture.start();
});
afterEach(async () => {
    await sidecar?.stop();
    for (const manager of managers) await manager.stop();
    managers.clear();
    for (const agent of agents) agent.destroy();
    agents.clear();
    jest.restoreAllMocks();
});
afterAll(async () => { await fixture?.close(); });

function backend(config = {}) {
    const value = service([], { REQUEST_MAX_RETRIES: 0, KIRO_FIRST_EVENT_TIMEOUT_MS: 1000, ...config });
    delete value._requestWithBuilderEndpointRouting;
    const agent = new https.Agent({ ca: fixture.ca, keepAlive: true });
    agents.add(agent);
    value.axiosInstance = axios.create({ httpsAgent: agent, proxy: false, headers: {
        'Content-Type': 'application/json', Accept: 'application/json', 'amz-sdk-request': 'attempt=1; max=3',
    } });
    value.baseUrl = `${fixture.url}/events`;
    value._markCredentialNeedRefresh = jest.fn();
    value._refreshUuid = jest.fn(() => null);
    return value;
}
function generate(value, context = sidecar.context, signal) {
    return value.streamApiReal('generate', model, request(), false, 0, { _transportContext: context, signal });
}
async function health() {
    const res = await localRequest(sidecar, null, { method: 'GET', route: '/health', data: undefined }).response;
    return JSON.parse((await readBody(res)).toString());
}
async function restart(env) { await sidecar.stop(); sidecar = await fixture.start(env); }

test('both real transports preserve split UTF-8, repeated deltas, tools and usage', async () => {
    fixture.handler = (_req, res) => {
        const bytes = frames();
        for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
        res.end();
    };
    const direct = await collect(generate(backend(), { kind: 'default' }));
    const proxied = await collect(generate(backend()));
    expect(proxied).toEqual(direct);
    expect(proxied.filter(event => event.type === 'content').map(event => event.content)).toEqual(['你好', '你好']);
    expect(fixture.requests.map(entry => entry.version)).toEqual(['1.1', '2.0']);
});

test('preserves top-level and case-insensitive Axios defaults after API-key routing', async () => {
    const value = backend({ KIRO_API_KEY_BASE_URL: `${fixture.url}/runtime` });
    value.accessToken = 'ksk_test';
    const data = { profileArn: 'remove-me', conversationState: { currentMessage: { userInputMessage: { origin: 'IDE', content: 'hello' } } } };
    const response = await value._requestWithBuilderEndpointRouting({ method: 'post', url: value.baseUrl, data,
        headers: { accept: 'application/vnd.test', Authorization: 'Bearer ksk_test' } }, data,
    { allowKiroSidecar: true, _transportContext: sidecar.context });
    await readBody(response.data);
    const sent = fixture.requests.at(-1);
    expect(sent.url).toBe('/runtime');
    expect(sent.headers).toMatchObject({ 'amz-sdk-request': 'attempt=1; max=3', accept: 'application/vnd.test',
        'content-type': 'application/x-amz-json-1.0', tokentype: 'API_KEY', 'x-amzn-codewhisperer-optout': 'false' });
    expect(JSON.parse(sent.body)).toMatchObject({ conversationState: { currentMessage: { userInputMessage: { origin: 'CLI' } } } });
    expect(JSON.parse(sent.body).profileArn).toBeUndefined();
    expect(data.profileArn).toBe('remove-me');
    expect(sent.headers['x-kiro-sidecar-token']).toBeUndefined();
});

test('Builder ID routes to CodeWhisperer before selecting the transport', async () => {
    const value = backend();
    value.authMethod = 'builder-id';
    value.codewhispererBaseUrl = `${fixture.url}/builder`;
    const data = { profileArn: 'remove-me' };
    // Routing recognizes the original AWS q endpoint, before the local rewrite.
    const response = await value._requestWithBuilderEndpointRouting({ method: 'post', url: 'https://q.us-east-1.amazonaws.com/generateAssistantResponse', data }, data,
        { allowKiroSidecar: true, _transportContext: sidecar.context });
    await readBody(response.data);
    expect(fixture.requests.at(-1).url).toBe('/builder');
    expect(JSON.parse(fixture.requests.at(-1).body).profileArn).toBeUndefined();
});

test('strips Connection-nominated business headers at both hops', async () => {
    const response = await localRequest(sidecar, `${fixture.url}/events`, { headers: {
        Connection: 'keep-alive, Amz-Sdk-Request', 'amz-sdk-request': 'local-only',
    } }).response;
    await readBody(response);
    expect(fixture.requests.at(-1).headers['amz-sdk-request']).toBeUndefined();
    const value = backend();
    const forwarded = await value._requestViaKiroSidecar({ url: `${fixture.url}/events`, data: {},
        headers: { Connection: 'Amz-Sdk-Request' } }, sidecar.context);
    await readBody(forwarded.data);
    expect(fixture.requests.at(-1).headers['amz-sdk-request']).toBeUndefined();
});

test('local authentication failure never refreshes or switches an AWS credential', async () => {
    const value = backend();
    await expect(collect(generate(value, { ...sidecar.context, localToken: 'wrong' }))).rejects.toMatchObject({
        code: 'LOCAL_AUTH_FAILED', isKiroSidecarError: true, skipErrorCount: true, shouldSwitchCredential: false, retryable: false,
    });
    expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(0);
});

test('genuine upstream 401 still follows AWS credential handling', async () => {
    fixture.handler = (_req, res) => { res.writeHead(401); res.end('{"message":"expired token"}'); };
    const value = backend();
    await expect(collect(generate(value))).rejects.toMatchObject({ shouldSwitchCredential: true, response: { status: 401 } });
    expect(value._markCredentialNeedRefresh).toHaveBeenCalledTimes(1);
});

test.each([402, 403, 429, 503])('preserves upstream %i status, headers and exact error body', async status => {
    const body = Buffer.from('{"message":"upstream policy failure"}');
    fixture.handler = (_req, res) => { res.writeHead(status, { 'x-amzn-requestid': 'aws-request-id', 'retry-after': '17' }); res.end(body); };
    let error;
    try { await backend()._requestViaKiroSidecar({ url: `${fixture.url}/error`, data: {} }, sidecar.context); }
    catch (caught) { error = caught; }
    expect(error.isKiroSidecarError).toBeUndefined();
    expect(error.response.status).toBe(status);
    expect(error.response.headers).toMatchObject({ 'x-amzn-requestid': 'aws-request-id', 'retry-after': '17' });
    expect(await readBody(error.response.data)).toEqual(body);
});

test('inflight slot remains held until the response is cancelled', async () => {
    await restart({ KIRO_SIDECAR_MAX_INFLIGHT: '1' });
    fixture.handler = (_req, res) => { res.writeHead(200); res.write(text('held')); };
    const first = await localRequest(sidecar, `${fixture.url}/hold`).response;
    expect(first.statusCode).toBe(200);
    expect((await health()).inflight).toBe(1);
    const value = backend();
    await expect(collect(generate(value))).rejects.toMatchObject({ code: 'SIDECAR_BUSY', shouldSwitchCredential: false });
    expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
    first.destroy();
    await waitFor(async () => (await health()).inflight === 0);
});

test('busy retries share the request budget and pin the selected instance', async () => {
    await restart({ KIRO_SIDECAR_MAX_INFLIGHT: '1' });
    fixture.handler = (_req, res) => { res.writeHead(200); res.write(text('held')); };
    const held = await localRequest(sidecar, `${fixture.url}/hold`).response;
    const manager = getKiroSidecar();
    jest.spyOn(manager, 'isReady').mockReturnValue(true);
    const selected = jest.spyOn(manager, 'getTransportContext').mockReturnValue(sidecar.context);
    const value = backend({ KIRO_SIDECAR_ENABLED: true, REQUEST_MAX_RETRIES: 1 });
    const send = value._requestViaKiroSidecar.bind(value);
    const contexts = [];
    jest.spyOn(value, '_requestViaKiroSidecar').mockImplementation(async (config, context) => {
        contexts.push(context);
        try { return await send(config, context); }
        catch (error) {
            expect(error.code).toBe('SIDECAR_BUSY');
            // Recovery affects subsequent requests; this request must retain its context.
            selected.mockReturnValue({ ...sidecar.context, localToken: 'replacement-instance' });
            fixture.handler = (_req, res) => res.end(frames());
            held.destroy();
            await waitFor(async () => (await health()).inflight === 0);
            throw error;
        }
    });
    expect((await collect(value.streamApiReal('generate', model, request()))).some(event => event.type === 'content')).toBe(true);
    expect(contexts).toEqual([sidecar.context, sidecar.context]);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
});

test('busy does not add an outer retry budget', async () => {
    await restart({ KIRO_SIDECAR_MAX_INFLIGHT: '1' });
    fixture.handler = (_req, res) => { res.writeHead(200); res.write(text('held')); };
    const held = await localRequest(sidecar, `${fixture.url}/hold`).response;
    const value = backend({ REQUEST_MAX_RETRIES: 1 });
    const send = jest.spyOn(value, '_requestViaKiroSidecar');
    try {
        await expect(collect(generate(value))).rejects.toMatchObject({
            code: 'SIDECAR_BUSY', skipErrorCount: true, shouldSwitchCredential: false, isRetryableUpstreamResponseFailure: false,
        });
        expect(send).toHaveBeenCalledTimes(2);
        expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
    } finally { held.destroy(); }
});

test('reserves body memory before receiving a slow upload', async () => {
    await restart({ KIRO_SIDECAR_MAX_BUFFER_BYTES: '100', KIRO_SIDECAR_MAX_PAYLOAD_BYTES: '1024' });
    const slow = localRequest(sidecar, `${fixture.url}/slow`, { headers: { 'Content-Length': '100' }, data: 'x'.repeat(99), end: false });
    try {
        await waitFor(async () => (await health()).buffer_bytes === 100, 3000, 'Slow upload reservation');
        const response = await localRequest(sidecar, `${fixture.url}/other`).response;
        expect(response.statusCode).toBe(503);
        expect(JSON.parse((await readBody(response)).toString()).code).toBe('SIDECAR_BUSY');
        expect(fixture.requests).toHaveLength(0);
    } finally { slow.request.destroy(); }
    await waitFor(async () => (await health()).buffer_bytes === 0, 3000, 'Slow upload cancellation release');
});

test.each(['ftp://user:secret@127.0.0.1:1', 'socks4://127.0.0.1:1', 'http://127.0.0.1:1/path'])('rejects invalid proxy %s without direct fallback', async proxy => {
    const value = backend({ TLS_SIDECAR_PROXY_URL: proxy });
    await expect(collect(generate(value))).rejects.toMatchObject({ code: 'INVALID_PROXY', retryable: false, shouldSwitchCredential: false });
    expect(fixture.requests).toHaveLength(0);
});

test('proxy credentials remain isolated when only the password changes', async () => {
    for (const password of ['first', 'second']) {
        const value = backend({ NODE_PROXY_URL: `http://account:${password}@127.0.0.1:${fixture.proxyPort}` });
        await collect(generate(value));
    }
    expect(fixture.connects.map(headers => headers['proxy-authorization'])).toEqual([
        `Basic ${Buffer.from('account:first').toString('base64')}`, `Basic ${Buffer.from('account:second').toString('base64')}`,
    ]);
});

test('proxy authentication errors are nonretryable local failures', async () => {
    fixture.proxyAuth = false;
    const value = backend({ NODE_PROXY_URL: `http://127.0.0.1:${fixture.proxyPort}`, REQUEST_MAX_RETRIES: 2 });
    await expect(collect(generate(value))).rejects.toMatchObject({ code: 'PROXY_AUTH_FAILED', retryable: false, shouldSwitchCredential: false });
    expect(fixture.connects).toHaveLength(1);
    expect(fixture.requests).toHaveLength(0);
});

test('one local call makes one upstream attempt after an HTTP/2 refusal', async () => {
    fixture.handler = (_req, res) => res.stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
    await expect(collect(generate(backend()))).rejects.toMatchObject({ isKiroSidecarError: true });
    expect(fixture.requests).toHaveLength(1);
});

test('negotiates HTTP/1.1 when the upstream does not support HTTP/2', async () => {
    const value = backend();
    value.baseUrl = `${fixture.http1Url}/events`;
    expect((await collect(generate(value))).some(event => event.type === 'content')).toBe(true);
    expect(fixture.requests.at(-1).version).toBe('1.1');
});

test.each(['crc', 'trailing-frame', 'exception'])('both transports reject %s corruption', async kind => {
    const bad = text('unsafe');
    bad[bad.length - 1] ^= 1;
    const bytes = kind === 'crc' ? bad : kind === 'trailing-frame' ? text('unsafe').subarray(0, -1)
        : frame('exception', { message: 'upstream failed' }, { ':message-type': 'exception', ':exception-type': 'InternalServerException' });
    fixture.handler = (_req, res) => res.end(bytes);
    for (const context of [{ kind: 'default' }, sidecar.context]) {
        await expect(collect(generate(backend(), context))).rejects.toMatchObject({ code: 'KIRO_STREAM_INTEGRITY' });
    }
});

test('body errors at complete-frame boundaries fail without retrying emitted content', async () => {
    let held;
    fixture.handler = (_req, res) => { held = res; res.write(text('visible')); };
    const stream = generate(backend({ REQUEST_MAX_RETRIES: 2 }));
    expect((await stream.next()).value).toEqual({ type: 'content', content: 'visible' });
    const rejection = expect(stream.next()).rejects.toMatchObject({ isKiroSidecarError: true, shouldSwitchCredential: false });
    held.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    await rejection;
    expect(fixture.requests).toHaveLength(1);
});

test('cancelling before upstream headers closes the upstream and releases the slot', async () => {
    let closed = false;
    fixture.handler = (_req, res) => res.once('close', () => { closed = true; });
    const controller = new AbortController();
    const value = backend();
    const operation = collect(generate(value, sidecar.context, controller.signal));
    const rejected = expect(operation).rejects.toThrow();
    await waitFor(() => fixture.requests.length === 1);
    controller.abort();
    await rejected;
    await waitFor(async () => closed && (await health()).inflight === 0);
    expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
});

test('final serialized body limit is enforced before sending', async () => {
    const value = backend({ KIRO_MAX_PAYLOAD_BYTES: 10 });
    await expect(value._requestViaKiroSidecar({ url: `${fixture.url}/events`, data: { content: 'too long' } }, sidecar.context))
        .rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE', retryable: false });
    expect(fixture.requests).toHaveLength(0);
});

test('managed Rust process exits when the parent pipe closes', async () => {
    const exited = once(sidecar.child, 'exit');
    sidecar.child.stdin.end();
    await exited;
    expect(sidecar.child.exitCode).toBe(0);
});

test('managed Rust process bounds draining an active stream after parent EOF', async () => {
    fixture.handler = (_req, res) => { res.writeHead(200); res.write(text('held')); };
    const held = await localRequest(sidecar, `${fixture.url}/hold`).response;
    held.on('error', () => {});
    held.resume();
    const exited = once(sidecar.child, 'exit');
    const started = Date.now();
    sidecar.child.stdin.end();
    await exited;
    expect(Date.now() - started).toBeLessThan(7000);
    expect(sidecar.child.exitCode).toBe(0);
    await waitFor(() => held.destroyed);
});

test('certificate hostname validation fails without retrying or penalizing the credential', async () => {
    const value = backend({ REQUEST_MAX_RETRIES: 2 });
    // Use the correct CA but a hostname absent from the certificate SANs.
    await restart({ KIRO_SIDECAR_TARGET_ALLOWLIST: `https://127.0.0.1:${fixture.port}` });
    value.baseUrl = `https://127.0.0.1:${fixture.port}/events`;
    const send = jest.spyOn(value, '_requestViaKiroSidecar');
    await expect(collect(generate(value))).rejects.toMatchObject({ code: 'TLS_ERROR', retryable: false, shouldSwitchCredential: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(0);
});

test('does not follow upstream redirects', async () => {
    fixture.handler = (_req, res) => { res.writeHead(307, { location: `${fixture.url}/redirected` }); res.end('redirect'); };
    await expect(backend()._requestViaKiroSidecar({ url: `${fixture.url}/events`, data: {} }, sidecar.context))
        .rejects.toMatchObject({ response: { status: 307 } });
    expect(fixture.requests).toHaveLength(1);
});

test('startup timeout reaps the child before scheduling a restart', async () => {
    const manager = new KiroSidecar({ startup: 80, health: 20, stop: 100, backoff: 10000 });
    managers.add(manager);
    const pending = manager.start({ binaryPath: '/bin/cat', port: await freePort() });
    const child = manager.process;
    expect(await pending).toBe(false);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(manager.process).toBeNull();
    await manager.stop();
    expect(manager.state).toBe('stopped');
    expect(manager.backoffTimer).toBeNull();
});

test('concurrent starts share one process and stop cancels an unfinished startup', async () => {
    const manager = new KiroSidecar({ startup: 1000, health: 50, stop: 100 });
    managers.add(manager);
    const first = manager.start({ binaryPath: '/bin/cat', port: await freePort() });
    const child = manager.process;
    expect(manager.start()).toBe(first);
    const stopping = manager.stop();
    expect(manager.stop()).toBe(stopping);
    expect(await first).toBe(false);
    await stopping;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(manager.state).toBe('stopped');
    expect(manager.isReady()).toBe(false);
    expect(manager.backoffTimer).toBeNull();
});

test('rolling restart budget survives successful readiness checks', async () => {
    const manager = new KiroSidecar({ startup: 1000, health: 50, backoff: 2, stop: 100 });
    managers.add(manager);
    expect(await manager.start({ binaryPath: binary, port: await freePort() })).toBe(true);
    for (let index = 0; index < 6; index++) {
        const old = manager.process;
        old.kill('SIGKILL');
        await waitFor(() => index === 5 ? manager.state === 'unavailable' : manager.isReady() && manager.process !== old);
    }
    expect(manager.restartTimestamps).toHaveLength(5);
    expect(manager.process).toBeNull();
});

test('health failure revokes readiness and recovery retains the same process', async () => {
    const manager = new KiroSidecar({ healthInterval: 20, health: 50, stop: 100 });
    managers.add(manager);
    expect(await manager.start({ binaryPath: binary, port: await freePort() })).toBe(true);
    const child = manager.process;
    const id = manager.instanceId;
    jest.spyOn(manager, '_healthCheck').mockResolvedValue(false);
    await waitFor(() => manager.state === 'unhealthy');
    expect(manager.getTransportContext()).toBeNull();
    manager._healthCheck.mockRestore();
    await waitFor(() => manager.isReady());
    expect(manager.process).toBe(child);
    expect(manager.instanceId).toBe(id);
    expect(manager.restartTimestamps).toHaveLength(0);
});

test('three health failures reap the old process before restarting', async () => {
    const manager = new KiroSidecar({ healthInterval: 15, health: 50, backoff: 2, stop: 100 });
    managers.add(manager);
    expect(await manager.start({ binaryPath: binary, port: await freePort() })).toBe(true);
    const child = manager.process;
    const check = manager._healthCheck.bind(manager);
    jest.spyOn(manager, '_healthCheck').mockImplementation((record, timeout) =>
        record.child === child ? Promise.resolve(false) : check(record, timeout));
    await waitFor(() => manager.isReady() && manager.process !== child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(manager.restartTimestamps).toHaveLength(1);
});

test('derives runtime, regional and explicitly configured account origins', async () => {
    const origins = await getKiroSidecarTargetOrigins({ providerPools: { 'claude-kiro-oauth': [{
        KIRO_BASE_URL: 'https://custom.example:8443/generate',
        KIRO_OAUTH_CREDS_BASE64: Buffer.from('{"region":"eu-central-1"}').toString('base64'),
    }] } });
    expect(origins).toEqual(expect.arrayContaining(['https://runtime.us-east-1.kiro.dev',
        'https://codewhisperer.eu-central-1.amazonaws.com', 'https://custom.example:8443']));
});

test('derives template origins from a configured credential directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-origins-'));
    try {
        fs.writeFileSync(path.join(dir, 'kiro-auth-token.json'), '{"region":"eu-central-1"}');
        const origins = await getKiroSidecarTargetOrigins({ KIRO_OAUTH_CREDS_DIR_PATH: dir,
            KIRO_BASE_URL: 'https://custom.{{region}}.example/generate',
        });
        expect(origins).toEqual(expect.arrayContaining(['https://custom.eu-central-1.example',
            'https://runtime.eu-central-1.kiro.dev', 'https://q.eu-central-1.amazonaws.com']));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invalid local protocol cannot be treated as an AWS authentication error', async () => {
    const server = http.createServer((_req, res) => { res.writeHead(401); res.end('unknown service'); });
    const port = await listen(server);
    const value = backend();
    try {
        await expect(collect(generate(value, { ...sidecar.context, baseUrl: `http://127.0.0.1:${port}` })))
            .rejects.toMatchObject({ code: 'SIDECAR_PROTOCOL_ERROR', shouldSwitchCredential: false });
        expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test.each([null, {}, { source: 'sidecar', code: 'UNKNOWN' }])('rejects malformed local error body %p without retrying', async body => {
    const server = http.createServer((_req, res) => {
        res.writeHead(503, { 'x-kiro-protocol-version': '1', 'x-kiro-response-source': 'sidecar' });
        res.end(JSON.stringify(body));
    });
    const port = await listen(server);
    const value = backend({ REQUEST_MAX_RETRIES: 2 });
    const send = jest.spyOn(value, '_requestViaKiroSidecar');
    try {
        await expect(collect(generate(value, { ...sidecar.context, baseUrl: `http://127.0.0.1:${port}` })))
            .rejects.toMatchObject({ code: 'SIDECAR_PROTOCOL_ERROR', retryable: false, shouldSwitchCredential: false });
        expect(send).toHaveBeenCalledTimes(1);
        expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
