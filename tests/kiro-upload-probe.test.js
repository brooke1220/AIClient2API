import { jest } from '@jest/globals';
import { EventEmitter, getEventListeners } from 'node:events';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import { createAgent, resolveProxy, send, tunnel } from '../src/scripts/kiro-upload-probe.mjs';

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
});
