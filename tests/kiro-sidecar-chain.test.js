import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { gzipSync } from 'node:zlib';
import axios from 'axios';
import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import KiroSidecar, { getKiroSidecar } from '../src/utils/kiro-sidecar.js';
import TLSSidecar, { getTLSSidecar } from '../src/utils/tls-sidecar.js';
import { configureTLSSidecar } from '../src/utils/proxy-utils.js';
import { selectKiroSidecarTransport } from '../src/providers/claude/kiro-sidecar-transport.js';
import { binary, createFixture, freePort, waitFor, readBody, localRequest, listen } from './helpers/kiro-sidecar-fixture.js';
import { service, collect, frame, text, request, model } from './helpers/kiro-safety-fixtures.js';

let fixture, rust, tls;
const agents = new Set();
const config = { KIRO_SIDECAR_ENABLED: true, TLS_SIDECAR_ENABLED: true, TLS_SIDECAR_ENABLED_PROVIDERS: ['claude-kiro-oauth'] };
const bytes = () => Buffer.concat([text('你好'), text('你好'), frame('metadataEvent', { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 8 } })]);
const chain = () => ({ ...rust.context, tlsSidecar: true });
const generate = (value = backend(), context = chain(), signal) => value.streamApiReal('', model, request(), false, 0, { _transportContext: context, signal });
async function rustHealth() {
    return JSON.parse((await readBody(await localRequest(rust, null, { method: 'GET', route: '/health' }).response)).toString());
}
function backend(overrides = {}) {
    const value = service([], { ...config, REQUEST_MAX_RETRIES: 0, KIRO_FIRST_EVENT_TIMEOUT_MS: 3000, ...overrides });
    delete value._requestWithBuilderEndpointRouting;
    value._applySidecar = outbound => configureTLSSidecar(outbound, value.config, 'claude-kiro-oauth');
    const agent = new https.Agent({ ca: fixture.ca, keepAlive: true });
    agents.add(agent);
    value.axiosInstance = axios.create({ proxy: false, httpsAgent: agent, headers: { 'Content-Type': 'application/json', 'amz-sdk-request': 'attempt=1; max=3' } });
    value.baseUrl = `${fixture.url}/events`;
    value._markCredentialNeedRefresh = jest.fn();
    value._refreshUuid = jest.fn(() => null);
    return value;
}
beforeAll(async () => { fixture = await createFixture(); });
beforeEach(async () => {
    fixture.requests.length = 0;
    fixture.connects.length = 0;
    fixture.proxyAuth = true;
    fixture.handler = (_req, res) => res.end(bytes());
    tls = await fixture.startTLS();
    rust = await fixture.start({ KIRO_TLS_SIDECAR_URL: tls.baseUrl });
    Object.assign(getTLSSidecar(), { ready: true, process: tls.child, baseUrl: tls.baseUrl, kiroRelayProtocolVersion: 1 });
    jest.spyOn(getKiroSidecar(), 'isReady').mockReturnValue(true);
    jest.spyOn(getKiroSidecar(), 'getTransportContext').mockReturnValue(rust.context);
});
afterEach(async () => {
    try {
        const results = await Promise.allSettled([
            Promise.resolve().then(() => rust?.stop()),
            Promise.resolve().then(() => tls?.stop()),
        ]);
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Sidecar cleanup failed');
    } finally {
        Object.assign(getTLSSidecar(), { ready: false, process: null, kiroRelayProtocolVersion: null });
        for (const agent of agents) agent.destroy();
        agents.clear();
        jest.restoreAllMocks();
    }
});
afterAll(async () => { await fixture?.close(); });

test('real Node, Go-only, Rust-only and chained transports return identical events', async () => {
    fixture.handler = (_req, res) => {
        const data = bytes();
        for (let i = 0; i < data.length; i += 7) res.write(data.subarray(i, i + 7));
        res.end();
    };
    const node = await collect(generate(backend({ TLS_SIDECAR_ENABLED: false }), { kind: 'default' }));
    expect(await collect(generate(backend(), { kind: 'default' }))).toEqual(node);
    expect((await tls.health()).kiro_relay_requests).toBe(0);
    expect(await collect(generate(backend(), rust.context))).toEqual(node);
    const auto = backend();
    expect(await collect(auto.streamApiReal('', model, request()))).toEqual(node);
    expect((await tls.health()).kiro_relay_requests).toBe(1);
    expect(fixture.requests.map(entry => entry.version)).toEqual(['1.1', '2.0', '2.0', '2.0']);
    for (const sent of fixture.requests) {
        expect(sent.headers.authorization).toBe('Bearer mock-only');
        expect(sent.headers['x-target-url']).toBeUndefined();
        expect(sent.headers['x-proxy-url']).toBeUndefined();
        expect(Object.keys(sent.headers).filter(key => key.startsWith('x-kiro-'))).toEqual([]);
    }
});

test('the production Rust manager passes the trusted Go endpoint to its child', async () => {
    const manager = new KiroSidecar();
    try {
        expect(await manager.start({ binaryPath: binary, port: await freePort(),
            tlsSidecarUrl: tls.baseUrl, targetOrigins: [fixture.url] })).toBe(true);
        const context = { ...manager.getTransportContext(), tlsSidecar: true };
        expect((await collect(generate(backend(), context))).some(event => event.type === 'content')).toBe(true);
        expect((await tls.health()).kiro_relay_requests).toBe(1);
    } finally { await manager.stop(); }
});

test('the production Go manager discovers relay capability and recovers after a crash', async () => {
    const manager = new TLSSidecar();
    const options = { binaryPath: tls.binaryPath, port: await freePort() };
    try {
        expect(await manager.start(options)).toBe(true);
        expect(manager.supportsKiroRelay()).toBe(true);
        const oldChild = manager.process;
        oldChild.kill('SIGKILL');
        await waitFor(() => !manager.isReady(), 3000, 'Go process exit');
        await waitFor(() => manager.isReady(), 6000, 'Go automatic restart');
        expect(manager.process).not.toBe(oldChild);
        expect(manager.supportsKiroRelay()).toBe(true);
        await manager.stop();
        expect(manager.supportsKiroRelay()).toBe(false);
        expect(await manager.start(options)).toBe(true);
    } finally { await manager.stop(); }
});

test.each([
    [{}, true],
    [{ TLS_SIDECAR_ENABLED_PROVIDERS: ['claude-kiro'] }, true],
    [{ TLS_SIDECAR_ENABLED_PROVIDERS: ['grok-web'] }, false],
    [{ TLS_SIDECAR_ENABLED: false }, false],
    [{ KIRO_SIDECAR_ENABLED: false }, false],
])('pins the configured route for %j', (overrides, chained) => {
    const selected = selectKiroSidecarTransport({ ...config, ...overrides });
    expect(Boolean(selected.tlsSidecar)).toBe(chained);
    expect(selected.kind).toBe(overrides.KIRO_SIDECAR_ENABLED === false ? 'default' : 'kiro-sidecar');
    if (chained) expect(Object.isFrozen(selected)).toBe(true);
});

test('unready Sidecars affect only newly selected requests', () => {
    const selected = selectKiroSidecarTransport(config);
    getTLSSidecar().ready = false;
    expect(selectKiroSidecarTransport(config).tlsSidecar).toBeUndefined();
    expect(selected.tlsSidecar).toBe(true);
    getKiroSidecar().isReady.mockReturnValue(false);
    expect(selectKiroSidecarTransport(config)).toEqual({ kind: 'default' });
});

test('an older Go binary is not selected for chained generation', () => {
    getTLSSidecar().kiroRelayProtocolVersion = null;
    expect(getTLSSidecar().isReady()).toBe(true);
    expect(selectKiroSidecarTransport(config)).toBe(rust.context);
    expect(fixture.requests).toHaveLength(0);
});

test('a paused account is checked again before either sidecar receives generation', async () => {
    const value = backend();
    const error = Object.assign(new Error('account paused'), { isKiroAccountUnavailable: true, skipErrorCount: true });
    const lease = { assertUsable: jest.fn(() => { throw error; }) };
    await expect(collect(value.streamApiReal('', model, request(), false, 0, {
        _transportContext: chain(), kiroAccountLease: lease,
    }))).rejects.toBe(error);
    expect(lease.assertUsable).toHaveBeenCalledTimes(1);
    expect((await tls.health()).kiro_relay_requests).toBe(0);
    expect(fixture.requests).toHaveLength(0);
    expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
    expect(error.shouldSwitchCredential).toBeUndefined();
});

test.each(['node', 'binding', 'kiro', 'global', 'direct'])('chained %s upstream preserves proxy precedence and authentication', async source => {
    const proxy = `http://${source}:secret@127.0.0.1:${fixture.proxyPort}`;
    const routes = {
        node: { NODE_PROXY_URL: proxy, KIRO_SIDECAR_PROXY_URL: 'http://127.0.0.1:0' },
        binding: { ipNodeProxy: { getProxyUrl: () => proxy }, KIRO_SIDECAR_PROXY_URL: 'http://127.0.0.1:0' },
        kiro: { KIRO_SIDECAR_PROXY_URL: proxy }, global: { PROXY_URL: proxy }, direct: {},
    };
    await collect(generate(backend({ TLS_SIDECAR_PROXY_URL: 'http://127.0.0.1:0', ...routes[source] })));
    expect((await tls.health()).kiro_relay_requests).toBe(1);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.connects.map(headers => headers['proxy-authorization'])).toEqual(source === 'direct' ? [] : [`Basic ${Buffer.from(`${source}:secret`).toString('base64')}`]);
});

test.each([401, 403, 429, 502])('upstream %i remains an upstream error even with spoofed control headers', async status => {
    fixture.handler = (_req, res) => {
        res.writeHead(status, { 'retry-after': '7', 'x-kiro-response-source': 'sidecar', 'x-kiro-protocol-version': 'wrong', 'x-kiro-error-code': 'TLS_ERROR' });
        res.end('exact AWS body');
    };
    try {
        await backend()._requestViaKiroSidecar({ url: `${fixture.url}/error`, data: {} }, chain());
        throw new Error('Expected upstream rejection');
    } catch (error) {
        expect(error.isKiroSidecarError).toBeUndefined();
        expect(error.response.status).toBe(status);
        expect(error.response.headers['retry-after']).toBe('7');
        expect((await readBody(error.response.data)).toString()).toBe('exact AWS body');
    }
});

test('genuine AWS 401 still marks the credential for refresh', async () => {
    fixture.handler = (_req, res) => { res.writeHead(401); res.end('expired'); };
    const value = backend();
    await expect(collect(generate(value))).rejects.toMatchObject({ shouldSwitchCredential: true, response: { status: 401 } });
    expect(value._markCredentialNeedRefresh).toHaveBeenCalledTimes(1);
});

test('Go proxy-auth failure is nonretryable and never penalizes the AWS credential', async () => {
    fixture.proxyAuth = false;
    const value = backend({ NODE_PROXY_URL: `http://127.0.0.1:${fixture.proxyPort}`, REQUEST_MAX_RETRIES: 2 });
    await expect(collect(generate(value))).rejects.toMatchObject({ code: 'PROXY_AUTH_FAILED', isKiroSidecarError: true, retryable: false, shouldSwitchCredential: false, skipErrorCount: true });
    expect(fixture.connects).toHaveLength(1);
    expect(fixture.requests).toHaveLength(0);
    expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
});

test('an unavailable selected Go hop never falls back to direct or switches accounts', async () => {
    await tls.stop();
    const value = backend();
    await expect(collect(generate(value))).rejects.toMatchObject({ code: 'TLS_SIDECAR_CONNECTION_ERROR', shouldSwitchCredential: false });
    expect(fixture.requests).toHaveLength(0);
    expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
});

test('Go certificate hostname validation remains enabled', async () => {
    await rust.stop();
    rust = await fixture.start({ KIRO_TLS_SIDECAR_URL: tls.baseUrl, KIRO_SIDECAR_TARGET_ALLOWLIST: `https://127.0.0.1:${fixture.port}` });
    const value = Object.assign(backend({ REQUEST_MAX_RETRIES: 2 }), { baseUrl: `https://127.0.0.1:${fixture.port}/events` });
    await expect(collect(generate(value))).rejects.toMatchObject({ code: 'TLS_ERROR', retryable: false, shouldSwitchCredential: false });
    expect((await tls.health()).kiro_relay_requests).toBe(1);
    expect(fixture.requests).toHaveLength(0);
    expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
});

test('a selected relay requires a configured local endpoint', async () => {
    await rust.stop();
    rust = await fixture.start({ KIRO_TLS_SIDECAR_URL: '' });
    await expect(collect(generate())).rejects.toMatchObject({ code: 'TLS_SIDECAR_UNAVAILABLE', shouldSwitchCredential: false });
    expect((await tls.health()).kiro_relay_requests).toBe(0);
    expect(fixture.requests).toHaveLength(0);
});

test('serial retries retain the Go hop and make one upstream attempt per call', async () => {
    let attempts = 0;
    fixture.handler = (_req, res) => {
        if (attempts++ === 0) {
            getTLSSidecar().ready = false;
            res.stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
        } else res.end(bytes());
    };
    const value = backend({ REQUEST_MAX_RETRIES: 1 });
    expect((await collect(value.streamApiReal('', model, request()))).some(event => event.type === 'content')).toBe(true);
    expect((await tls.health()).kiro_relay_requests).toBe(2);
    expect(fixture.requests).toHaveLength(2);
});

test('reusing frozen caller options selects a fresh route for each generation', async () => {
    const value = backend();
    const options = Object.freeze({});
    await collect(value.streamApiReal('', model, request(), false, 0, options));
    getTLSSidecar().ready = false;
    await collect(value.streamApiReal('', model, request(), false, 0, options));
    expect((await tls.health()).kiro_relay_requests).toBe(1);
    expect(fixture.requests).toHaveLength(2);
    expect(Object.keys(options)).toEqual([]);
});

test.each(['headers', 'body'])('cancellation during %s closes both hops and releases the Rust slot', async phase => {
    let closed = false;
    fixture.handler = (_req, res) => {
        res.once('close', () => { closed = true; });
        if (phase === 'body') res.write(text('visible'));
    };
    const controller = new AbortController();
    const value = backend();
    const iterator = generate(value, chain(), controller.signal);
    let pending;
    if (phase === 'body') {
        expect((await iterator.next()).value).toEqual({ type: 'content', content: 'visible' });
        pending = iterator.next();
    } else pending = iterator.next();
    const rejection = expect(pending).rejects.toThrow();
    await waitFor(() => fixture.requests.length === 1);
    controller.abort();
    await rejection;
    await waitFor(async () => closed && (await rustHealth()).inflight === 0);
    expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
});

test('a midstream failure after a complete frame is reported without replaying output', async () => {
    let held;
    fixture.handler = (_req, res) => { held = res; res.write(text('visible')); };
    const iterator = generate(backend({ REQUEST_MAX_RETRIES: 2 }));
    expect((await iterator.next()).value).toEqual({ type: 'content', content: 'visible' });
    const rejection = expect(iterator.next()).rejects.toMatchObject({ isKiroSidecarError: true, shouldSwitchCredential: false });
    held.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    await rejection;
    expect(fixture.requests).toHaveLength(1);
    expect((await tls.health()).kiro_relay_requests).toBe(1);
    await waitFor(async () => (await rustHealth()).inflight === 0);
});

test('HTTP/1.1 upstream connections are reused across chained requests', async () => {
    const value = backend();
    value.baseUrl = `${fixture.http1Url}/events`;
    for (let i = 0; i < 3; i++) await collect(generate(value));
    expect(fixture.requests.map(entry => entry.version)).toEqual(['1.1', '1.1', '1.1']);
    expect(new Set(fixture.requests.map(entry => entry.remotePort)).size).toBe(1);
});

test('compressed upstream bytes and encoding survive both hops unchanged', async () => {
    const compressed = gzipSync(bytes());
    fixture.handler = (_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(compressed); };
    const response = await localRequest(rust, `${fixture.url}/events`, { headers: { 'X-Kiro-Use-TLS-Sidecar': '1' } }).response;
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(await readBody(response)).toEqual(compressed);
    expect((await collect(generate())).some(event => event.type === 'content')).toBe(true);
});

test('target validation still happens in Rust before Go receives the request', async () => {
    await expect(collect(generate(Object.assign(backend(), { baseUrl: 'https://not-allowed.invalid/events' })))).rejects.toMatchObject({ code: 'INVALID_TARGET', retryable: false });
    expect((await tls.health()).kiro_relay_requests).toBe(0);
});

test('a relay without the expected protocol fails locally without interpreting its 401 as AWS', async () => {
    const fake = http.createServer((_req, res) => { res.writeHead(401); res.end('other local service'); });
    try {
        const port = await listen(fake);
        await rust.stop();
        rust = await fixture.start({ KIRO_TLS_SIDECAR_URL: `http://127.0.0.1:${port}` });
        const value = backend();
        await expect(collect(generate(value))).rejects.toMatchObject({ code: 'TLS_SIDECAR_PROTOCOL_ERROR', retryable: false, shouldSwitchCredential: false });
        expect(value._markCredentialNeedRefresh).not.toHaveBeenCalled();
    } finally { fake.closeAllConnections(); await new Promise(resolve => fake.close(resolve)); }
});
