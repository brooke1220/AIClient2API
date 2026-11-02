import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { spawn } from 'child_process';
import TLSSidecar from '../src/utils/tls-sidecar.js';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

function child() {
    const result = new EventEmitter();
    result.stdout = new PassThrough();
    result.stderr = new PassThrough();
    result.kill = jest.fn(signal => { queueMicrotask(() => result.emit('exit', 0, signal)); return true; });
    return result;
}

function manager() {
    const result = new TLSSidecar();
    result._findBinary = () => '/nonexistent-test-tls-sidecar';
    result._waitForReady = jest.fn(async () => { result.kiroRelayProtocolVersion = 1; return true; });
    return result;
}

afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

test('concurrent starts await one readiness check; explicit restart after stop works', async () => {
    spawn.mockImplementation(child);
    const value = manager();
    try {
        const first = value.start();
        expect(value.start()).toBe(first);
        expect(value.isReady()).toBe(false);
        expect(await first).toBe(true);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(value.supportsKiroRelay()).toBe(true);
        await value.stop();
        expect(value.supportsKiroRelay()).toBe(false);
        expect(await value.start()).toBe(true);
        expect(spawn).toHaveBeenCalledTimes(2);
    } finally { await value.stop(); }
});

test('a pending automatic restart cannot bring the child back after shutdown', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    spawn.mockImplementation(child);
    const value = manager();
    await value.start();
    value.process.emit('exit', 1, null);
    expect(value.isReady()).toBe(false);
    expect(value.healthCheckTimer).toBeNull();
    await value.stop();
    await jest.advanceTimersByTimeAsync(5000);
    expect(spawn).toHaveBeenCalledTimes(1);
});

test('shutdown during startup cannot mark the stopped child ready', async () => {
    spawn.mockImplementation(child);
    const value = manager();
    let release;
    value._waitForReady = jest.fn(() => new Promise(resolve => { release = resolve; }));
    const starting = value.start();
    await value.stop();
    release(true);
    expect(await starting).toBe(false);
    expect(value.isReady()).toBe(false);
    expect(value.healthCheckTimer).toBeNull();
    expect(value.restartTimer).toBeNull();
});

test('crashes after successful readiness still consume the rolling restart budget', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    spawn.mockImplementation(child);
    const value = manager();
    try {
        await value.start();
        for (let i = 0; i < 6; i++) {
            value.process.emit('exit', 1, null);
            await jest.advanceTimersByTimeAsync(2000);
        }
        expect(value.process).toBeNull();
        expect(spawn).toHaveBeenCalledTimes(6);
        expect(value.restartTimer).toBeNull();
    } finally { await value.stop(); }
});

test.each([
    [{ status: 'ok', kiro_relay_protocol_version: 1 }, true, true],
    [{ status: 'ok' }, true, false],
    [{ status: 'ok', kiro_relay_protocol_version: 2 }, true, false],
    [{ status: 'broken', kiro_relay_protocol_version: 1 }, false, false],
    ['invalid-json', false, false],
])('health distinguishes relay capability from generic readiness: %j', async (body, ready, relay) => {
    const server = http.createServer((_req, res) => res.end(typeof body === 'string' ? body : JSON.stringify(body)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const value = new TLSSidecar();
    value.process = {};
    value.baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
        value.ready = await value._healthCheck();
        expect(value.isReady()).toBe(ready);
        expect(value.supportsKiroRelay()).toBe(relay);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
