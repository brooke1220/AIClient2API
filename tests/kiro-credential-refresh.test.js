import { EventEmitter, getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
} }));
jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(), getRegisteredProviders: () => [],
    invalidateServiceAdapter: jest.fn(), serviceInstances: {}
}));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null), getApiServiceWithFallback: jest.fn() }));

import { getServiceAdapter } from '../src/providers/adapter.js';
import { getProviderPoolManager, getApiServiceWithFallback } from '../src/services/service-manager.js';
import { handleStreamRequest, handleUnaryRequest } from '../src/utils/common.js';
import { getKiroAccountUnavailableError } from '../src/providers/kiro-account-state.js';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { getKiroRefreshAheadMs, waitForKiroRefresh } from '../src/providers/kiro-credential-refresh.js';
import { collect, model, request, service, text } from './helpers/kiro-safety-fixtures.js';

const TYPE = 'claude-kiro-oauth';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
class MemoryPool extends ProviderPoolManager {
    _debouncedSave() {}
    _log() {}
    _logHealthStatusChange() {}
}
function pool(configs = [{ uuid: 'account' }], globalConfig = {}, extraPools = {}) {
    return new MemoryPool({ [TYPE]: configs.map(config => ({ isHealthy: true, ...config })), ...extraPools }, { globalConfig });
}
function refreshAdapter(pending) {
    const refresh = jest.fn(() => pending.promise);
    getServiceAdapter.mockReturnValue({ refreshToken: refresh, forceRefreshToken: refresh });
    return refresh;
}
function backend(manager, minutes = 5) {
    getProviderPoolManager.mockReturnValue(manager);
    const value = service([], { MODEL_PROVIDER: TYPE, uuid: 'account', KIRO_REFRESH_JITTER_MS: 0 });
    Object.assign(value, {
        uuid: 'account', expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
        _prepareAccessTokenForRequest: KiroApiService.prototype._prepareAccessTokenForRequest,
        _requestWithBuilderEndpointRouting: KiroApiService.prototype._requestWithBuilderEndpointRouting,
        axiosInstance: { request: jest.fn(async () => ({ data: Readable.from([text('answer')]) })) }
    });
    return value;
}

beforeEach(() => {
    jest.clearAllMocks();
    getProviderPoolManager.mockReturnValue(null);
});

describe('proactive Kiro credential refresh', () => {
    test('a near-expiry stream reaches upstream while its single background refresh is pending', async () => {
        const manager = pool();
        const pending = deferred();
        const refresh = refreshAdapter(pending);
        const value = backend(manager);
        const events = await collect(value.generateContentStream(model, request()));
        expect(events.some(event => event.delta?.text === 'answer')).toBe(true);
        expect(value.axiosInstance.request).toHaveBeenCalledTimes(1);
        expect(manager.providerStatus[TYPE][0].config.needsRefresh).toBe(false);
        await Promise.all(Array.from({ length: 20 }, () => value._prepareAccessTokenForRequest('concurrent')));
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledWith({ managedByPool: true });
        pending.resolve(true);
        await tick();
        expect(manager.providerStatus[TYPE][0].state._refreshTask).toBeUndefined();
    });

    test('a healthy token outside the configured window does not schedule a refresh', async () => {
        const manager = pool();
        const value = backend(manager, 20);
        await value._prepareAccessTokenForRequest('test');
        expect(getServiceAdapter).not.toHaveBeenCalled();
    });

    test('a transient proactive refresh failure leaves a valid account usable', async () => {
        const manager = pool();
        const pending = deferred();
        refreshAdapter(pending);
        const task = manager.requestKiroCredentialRefresh(TYPE, { uuid: 'account' });
        pending.reject(new Error('temporary refresh failure'));
        await expect(task).rejects.toThrow('temporary refresh failure');
        expect(() => manager.assertProviderAvailable(TYPE, 'account')).not.toThrow();
        expect(manager.requestKiroCredentialRefresh(TYPE, { uuid: 'account' })).toBeNull();
    });

    test('the cron and request windows share deterministic credential jitter', () => {
        const config = { KIRO_OAUTH_CREDS_FILE_PATH: '/mock/account.json' };
        const window = getKiroRefreshAheadMs(config);
        expect(window).toBeGreaterThanOrEqual(600000);
        expect(window).toBeLessThanOrEqual(630000);
        expect(getKiroRefreshAheadMs({ ...config, uuid: 'rotated' })).toBe(window);
        expect(getKiroRefreshAheadMs({ KIRO_REFRESH_AHEAD_MINUTES: 5, KIRO_REFRESH_JITTER_MS: 0 })).toBe(300000);
        expect(getKiroRefreshAheadMs({ KIRO_REFRESH_AHEAD_MINUTES: -1, KIRO_REFRESH_JITTER_MS: 0 })).toBe(600000);
    });
});

describe('required refresh and account routing', () => {
    test('an expired pooled token starts a managed refresh and permits switching before any upstream call', async () => {
        const manager = pool();
        const pending = deferred();
        const refresh = refreshAdapter(pending);
        const value = backend(manager, -1);
        await expect(collect(value.generateContentStream(model, request()))).rejects.toMatchObject({
            code: 'KIRO_ACCOUNT_UNAVAILABLE', kiroUnavailableReason: 'refresh', shouldSwitchCredential: true
        });
        expect(value.axiosInstance.request).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledTimes(1);
        pending.resolve(true);
        await tick();
    });

    test('a healthy alternate account is selected immediately', async () => {
        const manager = pool([{ uuid: 'account' }, { uuid: 'alternate' }]);
        const pending = deferred();
        refreshAdapter(pending);
        manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        const selected = await manager.acquireSlotWithFallback(TYPE, model);
        expect(selected.config.uuid).toBe('alternate');
        selected.config._slotLease.release();
        pending.resolve(true);
        await tick();
    });

    test('model discovery waits for the shared refresh and reloads its updated token', async () => {
        const manager = pool();
        const pending = deferred();
        refreshAdapter(pending);
        const value = backend(manager, -1);
        value.loadCredentials = jest.fn(async () => { value.accessToken = 'fresh-token'; });
        const operation = value._prepareAccessTokenForRequest('listModels');
        await tick();
        expect(value.loadCredentials).not.toHaveBeenCalled();
        pending.resolve(true);
        await operation;
        expect(value.loadCredentials).toHaveBeenCalledTimes(1);
        expect(value.accessToken).toBe('fresh-token');
    });

    test.each(['selectProviderWithFallback', 'acquireSlotWithFallback'])('%s waits once for a lone refreshing account', async method => {
        const manager = pool();
        const pending = deferred();
        const refresh = refreshAdapter(pending);
        const first = manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        expect(manager.markProviderNeedRefresh(TYPE, { uuid: 'account' })).toBe(first);
        let settled = false;
        const selections = Promise.all(Array.from({ length: 8 }, () => manager[method](TYPE, model))).then(results => {
            settled = true;
            return results;
        });
        await tick();
        expect(settled).toBe(false);
        expect(refresh).toHaveBeenCalledTimes(1);
        pending.resolve(true);
        const results = await selections;
        expect(results.every(result => result.config.uuid === 'account')).toBe(true);
        for (const result of results) result.config._slotLease?.release();
        expect(manager.providerStatus[TYPE][0].state.activeCount).toBe(0);
    });

    test('a compatible fallback is used before waiting for primary credentials', async () => {
        const manager = pool(undefined, { providerFallbackChain: { [TYPE]: ['claude-custom'] } }, {
            'claude-custom': [{ uuid: 'fallback', isHealthy: true }]
        });
        const pending = deferred();
        refreshAdapter(pending);
        manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        const result = await manager.acquireSlotWithFallback(TYPE, model);
        expect(result.actualProviderType).toBe('claude-custom');
        result.config._slotLease.release();
        pending.resolve(true);
        await tick();
    });

    test('a completed refresh does not outrank an untried healthy account on retry', async () => {
        const manager = pool([{ uuid: 'account' }, { uuid: 'alternate' }]);
        const result = await manager.selectProviderWithFallback(TYPE, model, { preferOtherUuids: ['account'] });
        expect(result.config.uuid).toBe('alternate');
    });

    test('failed required refresh returns a refresh error and cools down the invalid credential', async () => {
        const manager = pool();
        const pending = deferred();
        refreshAdapter(pending);
        manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        const selected = manager.acquireSlotWithFallback(TYPE, model);
        const failure = expect(selected).rejects.toMatchObject({ code: 'KIRO_CREDENTIAL_REFRESH_FAILED', status: 503 });
        await tick();
        pending.reject(new Error('refresh service unavailable'));
        await failure;
        const config = manager.providerStatus[TYPE][0].config;
        expect(config.needsRefresh).toBe(false);
        expect(config.isHealthy).toBe(false);
        expect(Date.parse(config.scheduledRecoveryTime)).toBeGreaterThan(Date.now());
        expect(await manager.selectProvider(TYPE, model)).toBeNull();
    });

    test('excluded or model-incompatible refreshing accounts are never awaited', async () => {
        const manager = pool([{ uuid: 'account', notSupportedModels: [model] }]);
        const pending = deferred();
        refreshAdapter(pending);
        manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        expect(await manager.acquireSlotWithFallback(TYPE, model)).toBeNull();
        expect(await manager.acquireSlotWithFallback(TYPE, null, { excludeUuids: ['account'] })).toBeNull();
        pending.resolve(true);
        await tick();
    });

    test('a refresh that fails before selection starts still returns the correct refresh failure', async () => {
        const manager = pool();
        const pending = deferred();
        refreshAdapter(pending);
        const task = manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        pending.reject(new Error('refresh token is invalid'));
        await expect(task).rejects.toThrow('refresh token is invalid');
        await expect(manager.acquireSlotWithFallback(TYPE, model)).rejects.toMatchObject({
            code: 'KIRO_CREDENTIAL_REFRESH_FAILED', status: 503
        });
    });
});

describe('shared refresh lifetime and authoritative account state', () => {
    test('cancelling one waiter leaves another waiter and the refresh running', async () => {
        const manager = pool();
        const pending = deferred();
        refreshAdapter(pending);
        manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        const controller = new AbortController();
        const cancelled = manager.acquireSlotWithFallback(TYPE, model, { signal: controller.signal });
        const active = manager.acquireSlotWithFallback(TYPE, model);
        const reason = new Error('client disconnected');
        const failure = expect(cancelled).rejects.toBe(reason);
        await tick();
        controller.abort(reason);
        await failure;
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        expect(manager.providerStatus[TYPE][0].state._refreshTask).toBeDefined();
        pending.resolve(true);
        const selected = await active;
        selected.config._slotLease.release();
    });

    test('the wait deadline includes time queued behind the global refresh limit', async () => {
        const manager = pool(undefined, { REFRESH_CONCURRENCY_GLOBAL: 0, KIRO_REFRESH_WAIT_TIMEOUT_MS: 20 });
        const pending = deferred();
        const refresh = refreshAdapter(pending);
        manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        const controller = new AbortController();
        await expect(manager.acquireSlotWithFallback(TYPE, model, { signal: controller.signal })).rejects.toMatchObject({
            code: 'KIRO_CREDENTIAL_REFRESH_TIMEOUT', status: 503
        });
        expect(refresh).not.toHaveBeenCalled();
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        manager.refreshConcurrency.global = 1;
        manager.globalRefreshWaiters.shift()();
        pending.resolve(true);
        await tick();
    });

    test.each(['disabled', 'suspended', 'cooldown'])('a completed refresh cannot override a new %s state', async change => {
        const manager = pool();
        const pending = deferred();
        refreshAdapter(pending);
        const task = manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        const config = manager.providerStatus[TYPE][0].config;
        if (change === 'disabled') manager.disableProvider(TYPE, config);
        if (change === 'suspended') manager.markProviderUnhealthyImmediately(TYPE, config, '403 account suspended');
        if (change === 'cooldown') manager.markProviderUnhealthyWithRecoveryTime(TYPE, config, 'quota', new Date(Date.now() + 60000));
        pending.resolve(true);
        await task;
        expect(() => manager.assertProviderAvailable(TYPE, 'account')).toThrow(/unavailable/);
    });

    test('UUID rotation and hot reload retain the same refresh task and clear current state on success', async () => {
        const manager = pool();
        const pending = deferred();
        const refresh = refreshAdapter(pending);
        const task = manager.requestKiroCredentialRefresh(TYPE, { uuid: 'account' });
        const uuid = manager.refreshProviderUuid(TYPE, { uuid: 'account' });
        manager.initializeProviderStatus();
        expect(manager.markProviderNeedRefresh(TYPE, { uuid })).toBe(task);
        pending.resolve(true);
        await task;
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(manager.providerStatus[TYPE][0].config.needsRefresh).toBe(false);
        expect(manager.providerStatus[TYPE][0].state._refreshTask).toBeUndefined();
        expect(manager.refreshingUuids.size).toBe(0);
    });

    test('required refresh promotes a proactively buffered task instead of creating another', async () => {
        const manager = pool(Array.from({ length: 6 }, (_, index) => ({ uuid: index ? `other-${index}` : 'account' })));
        const pending = deferred();
        const refresh = refreshAdapter(pending);
        const proactive = manager.requestKiroCredentialRefresh(TYPE, { uuid: 'account' });
        expect(refresh).not.toHaveBeenCalled();
        expect(manager.markProviderNeedRefresh(TYPE, { uuid: 'account' })).toBe(proactive);
        expect(refresh).toHaveBeenCalledTimes(1);
        pending.resolve(true);
        await proactive;
        expect(manager.refreshBufferQueues[TYPE].size).toBe(0);
    });

    test('a timed-out pool task cannot publish a late success into account availability', async () => {
        const manager = pool(undefined, { REFRESH_TASK_TIMEOUT_MS: 20 });
        const pending = deferred();
        refreshAdapter(pending);
        const task = manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        await expect(task).rejects.toThrow(/timeout/);
        pending.resolve(true);
        await tick();
        expect(() => manager.assertProviderAvailable(TYPE, 'account')).toThrow(/cooling down/);
    });
});

describe('standalone refresh and request headers', () => {
    test('standalone expired requests share one rotation and a cancelled waiter does not cancel it', async () => {
        const value = backend(null, -1);
        const pending = deferred();
        value.loadCredentials = jest.fn(async () => {});
        value.credsFilePath = '/mock/standalone.json';
        value.refreshToken = 'mock-refresh';
        value._doTokenRefresh = jest.fn(async () => {
            await pending.promise;
            value.accessToken = 'fresh-token';
            value.expiresAt = new Date(Date.now() + 3600000).toISOString();
        });
        const controller = new AbortController();
        const first = value._prepareAccessTokenForRequest('first', { signal: controller.signal });
        const second = value._prepareAccessTokenForRequest('second');
        const failed = expect(first).rejects.toThrow('disconnected');
        await tick();
        controller.abort(new Error('disconnected'));
        await failed;
        pending.resolve();
        await second;
        expect(value._doTokenRefresh).toHaveBeenCalledTimes(1);
        expect(value.accessToken).toBe('fresh-token');
    });

    test('headers use the current token after a queued attempt was built with an older token', async () => {
        const value = backend(null, 60);
        value.accessToken = 'fresh-token';
        const config = { method: 'post', url: value.baseUrl, headers: { Authorization: 'Bearer old-token' } };
        const result = await value._requestWithBuilderEndpointRouting(config, {});
        result.data.destroy();
        expect(value.axiosInstance.request).toHaveBeenCalledWith(expect.objectContaining({ headers: { Authorization: 'Bearer fresh-token' } }));
        expect(config.headers.Authorization).toBe('Bearer old-token');
    });

    test('API keys do not attempt OAuth rotation because they have no expiresAt', async () => {
        const value = backend(null);
        value.accessToken = 'ksk_mock';
        value.expiresAt = null;
        value.initializeAuth = jest.fn();
        await value._prepareAccessTokenForRequest('api-key');
        expect(value.initializeAuth).not.toHaveBeenCalled();
    });

    test('an already cancelled wait never leaves an abort listener', async () => {
        const controller = new AbortController();
        controller.abort(new Error('already disconnected'));
        await expect(waitForKiroRefresh(Promise.resolve(), { signal: controller.signal })).rejects.toThrow('already disconnected');
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });
});

describe('public request recovery', () => {
    function response() {
        const res = new EventEmitter();
        Object.assign(res, { writableEnded: false, destroyed: false, headersSent: false });
        res.writeHead = jest.fn(() => { res.headersSent = true; });
        res.flushHeaders = jest.fn();
        res.write = jest.fn(() => true);
        res.end = jest.fn(() => { res.writableEnded = true; });
        return res;
    }
    const delta = () => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'recovered' } });
    const config = () => ({ MODEL_PROVIDER: TYPE, CREDENTIAL_SWITCH_MAX_RETRIES: 2, SSE_HEARTBEAT_INTERVAL_MS: 0 });

    test.each(['stream', 'unary'])('%s waits for its expired token with zero credential switches', async mode => {
        const manager = pool();
        const pending = deferred();
        const value = backend(manager, -1);
        value.loadCredentials = jest.fn(async () => {});
        const refresh = jest.fn(async () => {
            await pending.promise;
            value.accessToken = 'fresh-token';
            value.expiresAt = new Date(Date.now() + 3600000).toISOString();
            return true;
        });
        getServiceAdapter.mockReturnValue({ refreshToken: refresh, forceRefreshToken: refresh });
        const acquired = await manager.acquireSlot(TYPE, model);
        const res = response();
        const handler = mode === 'stream' ? handleStreamRequest : handleUnaryRequest;
        const operation = handler(res, value, model, request(), TYPE, TYPE, 'none', null, manager, 'account', null, {
            CONFIG: { ...config(), CREDENTIAL_SWITCH_MAX_RETRIES: 0 }, slotLease: acquired._slotLease
        });
        await tick();
        expect(res.writableEnded).toBe(false);
        expect(value.axiosInstance.request).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledTimes(1);
        pending.resolve();
        await operation;
        expect([...res.write.mock.calls, ...res.end.mock.calls].map(([record]) => record || '').join('')).toContain('answer');
        expect(value.axiosInstance.request.mock.calls[0][0].headers.Authorization).toBe('Bearer fresh-token');
        expect(getApiServiceWithFallback).not.toHaveBeenCalled();
        expect(manager.providerStatus[TYPE][0].state.activeCount).toBe(0);
    });

    test.each(['stream', 'unary'])('%s waits for a previously paused account after its switch budget is exhausted', async mode => {
        const manager = pool();
        const pending = deferred();
        refreshAdapter(pending);
        const value = backend(manager, 60);
        value.loadCredentials = jest.fn(async () => { value.accessToken = 'fresh-token'; });
        const acquired = await manager.acquireSlot(TYPE, model);
        manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        const res = response();
        const handler = mode === 'stream' ? handleStreamRequest : handleUnaryRequest;
        const operation = handler(res, value, model, request(), TYPE, TYPE, 'none', null, manager, 'account', null, {
            CONFIG: config(), currentRetry: 2, slotLease: acquired._slotLease
        });
        await tick();
        expect(res.writableEnded).toBe(false);
        expect(value.axiosInstance.request).not.toHaveBeenCalled();
        pending.resolve(true);
        await operation;
        expect([...res.write.mock.calls, ...res.end.mock.calls].map(([record]) => record || '').join('')).toContain('answer');
        expect(getApiServiceWithFallback).not.toHaveBeenCalled();
        expect(manager.providerStatus[TYPE][0].state.activeCount).toBe(0);
    });

    test('zero-switch refresh waits still honor cancellation and release their lease', async () => {
        const manager = pool();
        const pending = deferred();
        refreshAdapter(pending);
        const value = backend(manager, -1);
        const acquired = await manager.acquireSlot(TYPE, model);
        const controller = new AbortController();
        const res = response();
        const operation = handleUnaryRequest(res, value, model, request(), TYPE, TYPE, 'none', null, manager, 'account', null, {
            CONFIG: { ...config(), CREDENTIAL_SWITCH_MAX_RETRIES: 0 }, slotLease: acquired._slotLease,
            upstreamAbortController: controller
        });
        await tick();
        controller.abort(new Error('client disconnected'));
        await operation;
        expect(value.axiosInstance.request).not.toHaveBeenCalled();
        expect(acquired._slotLease.released).toBe(true);
        expect(manager.providerStatus[TYPE][0].state._refreshTask).toBeDefined();
        pending.resolve(true);
        await tick();
    });

    test.each(['stream', 'unary'])('%s recovers a lone refreshing account without an added retry delay', async mode => {
        const manager = pool();
        const pending = deferred();
        refreshAdapter(pending);
        const acquired = await manager.acquireSlot(TYPE, model);
        manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        const generateContentStream = jest.fn(async function* () { yield delta(); yield { type: 'message_stop' }; });
        const generateContent = jest.fn(async () => ({ type: 'message', content: [{ type: 'text', text: 'recovered' }], usage: {} }));
        getApiServiceWithFallback.mockImplementation(async (_, __, options) => {
            const result = await manager.acquireSlotWithFallback(TYPE, model, options);
            return { service: { generateContentStream, generateContent }, uuid: result.config.uuid,
                slotLease: result.config._slotLease, actualProviderType: TYPE, serviceConfig: result.config };
        });
        const res = response();
        const context = { CONFIG: config(), slotLease: acquired._slotLease, upstreamAbortController: new AbortController() };
        const handler = mode === 'stream' ? handleStreamRequest : handleUnaryRequest;
        const operation = handler(res, {}, model, request(), TYPE, TYPE, 'none', null, manager, 'account', null, context);
        await tick();
        expect(getApiServiceWithFallback).toHaveBeenCalledTimes(1);
        expect(acquired._slotLease.released).toBe(true);
        pending.resolve(true);
        await operation;
        expect([...res.write.mock.calls, ...res.end.mock.calls].map(([record]) => record || '').join('')).toContain('recovered');
        expect(manager.providerStatus[TYPE][0].state.activeCount).toBe(0);
    });

    test('the stream reports the refresh timeout instead of the original pending-refresh error', async () => {
        const manager = pool(undefined, { KIRO_REFRESH_WAIT_TIMEOUT_MS: 20 });
        const pending = deferred();
        refreshAdapter(pending);
        const acquired = await manager.acquireSlot(TYPE, model);
        manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        getApiServiceWithFallback.mockImplementation((_, __, options) => manager.acquireSlotWithFallback(TYPE, model, options));
        const res = response();
        await handleStreamRequest(res, {}, model, request(), TYPE, TYPE, 'none', null, manager, 'account', null,
            { CONFIG: config(), slotLease: acquired._slotLease });
        const records = res.write.mock.calls.map(([record]) => record).join('');
        expect(records).toContain('Timed out waiting for Kiro credential refresh');
        expect(records).not.toContain('awaiting credential refresh');
        pending.resolve(true);
        await tick();
    });

    test('unary refresh timeouts use HTTP 503', async () => {
        const manager = pool(undefined, { KIRO_REFRESH_WAIT_TIMEOUT_MS: 20 });
        const pending = deferred();
        refreshAdapter(pending);
        const acquired = await manager.acquireSlot(TYPE, model);
        manager.markProviderNeedRefresh(TYPE, { uuid: 'account' });
        getApiServiceWithFallback.mockImplementation((_, __, options) => manager.acquireSlotWithFallback(TYPE, model, options));
        const res = response();
        await handleUnaryRequest(res, {}, model, request(), TYPE, TYPE, 'none', null, manager, 'account', null,
            { CONFIG: config(), slotLease: acquired._slotLease });
        expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
        expect(res.end.mock.calls.map(([record]) => record || '').join('')).toContain('Timed out waiting for Kiro credential refresh');
        pending.resolve(true);
        await tick();
    });

    test('a refresh failure after output never switches accounts or replays the stream', async () => {
        const manager = pool();
        const acquired = await manager.acquireSlot(TYPE, model);
        const error = getKiroAccountUnavailableError(TYPE, { needsRefresh: true });
        const generateContentStream = jest.fn(async function* () { yield delta(); throw error; });
        const res = response();
        await handleStreamRequest(res, { generateContentStream }, model, request(), TYPE, TYPE, 'none', null, manager, 'account', null,
            { CONFIG: config(), slotLease: acquired._slotLease });
        expect(getApiServiceWithFallback).not.toHaveBeenCalled();
        expect(generateContentStream).toHaveBeenCalledTimes(1);
        expect(res.write.mock.calls.map(([record]) => record).join('').match(/recovered/g)).toHaveLength(1);
        expect(manager.providerStatus[TYPE][0].state.activeCount).toBe(0);
    });
});

describe('health probes with dynamic model discovery', () => {
    test.each(['unhealthy', 'suspended', 'cooldown'])('discovery preserves an authorized %s probe', async reason => {
        const state = reason === 'unhealthy' ? { isHealthy: false }
            : reason === 'suspended' ? { isHealthy: false, kiroAccountSuspended: true }
            : { isHealthy: false, scheduledRecoveryTime: new Date(Date.now() + 60000).toISOString() };
        const manager = pool([{ uuid: 'account', ...state }]);
        const value = backend(manager, 60);
        value.config.KIRO_DYNAMIC_MODELS = true;
        value.axiosInstance.request.mockImplementation(async config => config.method === 'get'
            ? { data: { models: [{ modelId: model }] } }
            : { data: Readable.from([text('answer')]) });
        const events = await collect(value.generateContentStream(model, request(), {
            kiroHealthCheck: true, kiroManualRecovery: reason !== 'unhealthy'
        }));
        expect(events.some(event => event.delta?.text === 'answer')).toBe(true);
        expect(value.axiosInstance.request).toHaveBeenCalledTimes(2);
        // A probe does not itself authorize ordinary traffic on the paused node.
        await expect(collect(value.generateContentStream(model, request()))).rejects.toMatchObject({
            code: 'KIRO_ACCOUNT_UNAVAILABLE', kiroUnavailableReason: reason
        });
    });
});

describe('credential rejections across a completed refresh', () => {
    test.each(['stream', 'legacy'])('%s ignores a late old-token 401 but refreshes a rejected new token', async mode => {
        const manager = pool();
        const value = backend(manager, 60);
        const refresh = jest.fn(async () => {
            value.accessToken = `fresh-token-${refresh.mock.calls.length}`;
            return true;
        });
        getServiceAdapter.mockReturnValue({ refreshToken: refresh, forceRefreshToken: refresh, kiroApiService: value });
        const attempts = [];
        value.axiosInstance.request.mockImplementation(config => new Promise((_, reject) => { attempts.push({ config, reject }); }));
        const generate = () => mode === 'stream' ? collect(value.streamApiReal('', model, request())) : value.callApi('', model, request());
        const first = expect(generate()).rejects.toMatchObject({ response: { status: 401 } });
        const second = expect(generate()).rejects.toMatchObject({ response: { status: 401 } });
        const unauthorized = () => Object.assign(new Error('token rejected'), { response: { status: 401, data: {} } });
        await tick();
        expect(attempts).toHaveLength(2);
        attempts[0].reject(unauthorized());
        await first;
        await tick();
        expect(refresh).toHaveBeenCalledTimes(1);
        const refreshedUuid = value.uuid;
        // Verify that the deduplication state survives a real configuration reload.
        manager.providerPools[TYPE] = manager.providerPools[TYPE].map(config => ({ ...config }));
        manager.initializeProviderStatus();
        attempts[1].reject(unauthorized());
        await second;
        await tick();
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(value.uuid).toBe(refreshedUuid);
        expect(() => manager.assertProviderAvailable(TYPE, value.uuid)).not.toThrow();
        const third = expect(generate()).rejects.toMatchObject({ response: { status: 401 } });
        await tick();
        expect(attempts[2].config.headers.Authorization).toBe('Bearer fresh-token-1');
        attempts[2].reject(unauthorized());
        await third;
        await tick();
        expect(refresh).toHaveBeenCalledTimes(2);
    });
});

describe('usage queries', () => {
    const usage = { usageBreakdownList: [] };

    test('an expired idle token is refreshed before the usage request is sent', async () => {
        const manager = pool();
        const pending = deferred();
        const refresh = refreshAdapter(pending);
        const value = backend(manager, -1);
        value.loadCredentials = jest.fn(async () => { value.accessToken = 'fresh-token'; });
        value.axiosInstance.request.mockResolvedValue({ data: usage });
        const operation = value.getUsageLimits();
        await tick();
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(value.axiosInstance.request).not.toHaveBeenCalled();
        pending.resolve(true);
        await expect(operation).resolves.toEqual(usage);
        expect(value.axiosInstance.request).toHaveBeenCalledTimes(1);
        expect(value.axiosInstance.request.mock.calls[0][0].headers.Authorization).toBe('Bearer fresh-token');
    });

    test('a failed refresh reports its cause without calling upstream', async () => {
        const manager = pool();
        const pending = deferred();
        refreshAdapter(pending);
        const value = backend(manager, -1);
        const operation = value.getUsageLimits();
        pending.promise.catch(() => {});
        pending.reject(new Error('Token refresh failed (HTTP 400): invalid_grant'));
        await expect(operation).rejects.toThrow('Kiro credential refresh failed before request: Token refresh failed (HTTP 400): invalid_grant');
        expect(value.axiosInstance.request).not.toHaveBeenCalled();
    });

    test.each([
        ['unhealthy', { isHealthy: false }],
        ['suspended', { isHealthy: false, kiroAccountSuspended: true }],
        ['cooldown', { isHealthy: false, scheduledRecoveryTime: new Date(Date.now() + 60000).toISOString() }]
    ])('a %s account can still be queried', async (_, state) => {
        const manager = pool([{ uuid: 'account', ...state }]);
        const value = backend(manager, 60);
        value.axiosInstance.request.mockResolvedValue({ data: usage });
        await expect(value.getUsageLimits()).resolves.toEqual(usage);
        expect(getServiceAdapter).not.toHaveBeenCalled();
    });
});
