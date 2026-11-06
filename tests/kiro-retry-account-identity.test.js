import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
} }));
jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(), getRegisteredProviders: () => [],
    invalidateServiceAdapter: jest.fn(), serviceInstances: {}
}));

import logger from '../src/utils/logger.js';
import { getServiceAdapter } from '../src/providers/adapter.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { initApiService, getProviderPoolManager, getApiServiceWithFallback } from '../src/services/service-manager.js';
import { createEmptyUpstreamResponseError, handleStreamRequest, handleUnaryRequest } from '../src/utils/common.js';
import '../src/converters/register-converters.js';

const TYPE = 'claude-kiro-oauth';
const MODEL = 'claude-sonnet-4-5';
const SESSION = { key: 'retry-account-identity' };
const tick = () => new Promise(resolve => setImmediate(resolve));

function response() {
    const res = new EventEmitter();
    Object.assign(res, { writableEnded: false, destroyed: false, writableNeedDrain: false, headersSent: false });
    res.writeHead = jest.fn(() => { res.headersSent = true; });
    res.flushHeaders = jest.fn();
    res.write = jest.fn(() => true);
    res.end = jest.fn(() => { res.writableEnded = true; });
    return res;
}

function upstreamUnavailable() {
    return Object.assign(new Error('upstream unavailable'), {
        response: { status: 503 }, skipErrorCount: true, shouldSwitchCredential: true
    });
}

async function fixture(names, failureFor = () => null) {
    const attempts = [];
    const config = {
        MODEL_PROVIDER: TYPE, CREDENTIAL_SWITCH_MAX_RETRIES: 2, SSE_HEARTBEAT_INTERVAL_MS: 0,
        EMPTY_RESPONSE_RETRY_DELAY_MS: 100, EMPTY_RESPONSE_MAX_RETRIES: 1,
        providerPools: { [TYPE]: names.map(name => ({
            uuid: `account-${name}`, customName: name, isHealthy: true, concurrencyLimit: 1
        })) }
    };
    const backends = new Map(names.map(name => {
        const generate = () => {
            attempts.push(name);
            const failure = failureFor(name, attempts.filter(account => account === name).length);
            if (failure) throw failure;
        };
        return [name, {
            generateContent: async () => {
                generate();
                return { id: 'message', type: 'message', role: 'assistant', model: MODEL,
                    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
                    usage: { input_tokens: 1, output_tokens: 1 } };
            },
            generateContentStream: async function* () {
                generate();
                yield { type: 'message_start', message: { id: 'message', type: 'message', role: 'assistant',
                    model: MODEL, content: [], usage: { input_tokens: 1, output_tokens: 0 } } };
                yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
                yield { type: 'message_stop' };
            }
        }];
    }));
    getServiceAdapter.mockImplementation(nodeConfig => backends.get(nodeConfig.customName));
    await initApiService({ providerPools: {} });
    await initApiService(config);
    const manager = getProviderPoolManager();
    manager.captureKiroSessionBinding(TYPE, `account-${names[0]}`, SESSION.key)();
    const initial = await getApiServiceWithFallback(config, MODEL, { acquireSlot: true, kiroSession: SESSION });
    const run = async mode => {
        const res = response();
        await (mode === 'stream' ? handleStreamRequest : handleUnaryRequest)(
            res, initial.service, MODEL, { messages: [{ role: 'user', content: 'hello' }] },
            'claude', TYPE, 'none', null, manager, initial.uuid, null,
            { CONFIG: config, slotLease: initial.slotLease, kiroSession: SESSION });
        expect(res.writableEnded).toBe(true);
        expect(manager.providerStatus[TYPE].every(provider =>
            provider.state.activeCount === 0 && provider.state.waitingCount === 0)).toBe(true);
        return res;
    };
    return { manager, initial, attempts, run };
}

beforeEach(() => {
    jest.clearAllMocks();
    logger.info.mockReset();
    logger.warn.mockReset();
    jest.spyOn(Math, 'random').mockReturnValue(0.01); // 100 ms when another account is available.
    jest.spyOn(ProviderPoolManager.prototype, '_debouncedSave').mockImplementation(() => {});
    jest.spyOn(ProviderPoolManager.prototype, '_log').mockImplementation(() => {});
    jest.spyOn(ProviderPoolManager.prototype, '_logHealthStatusChange').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('Kiro retry history follows account UUID rotation', () => {
    test.each(['stream', 'unary'])('%s leaves the failed account when it rotates during the switch delay', async mode => {
        const value = await fixture(['a', 'b'], name => name === 'a' ? upstreamUnavailable() : null);
        let rotation;
        logger.info.mockImplementation(message => {
            if (rotation || !String(message).includes('Waiting 100ms before retry')) return;
            rotation = new Promise(resolve => setTimeout(() => resolve(
                value.manager.refreshProviderUuid(TYPE, { uuid: 'account-a' })), 0));
        });
        await value.run(mode);
        expect(rotation).toBeInstanceOf(Promise);
        expect(await rotation).toEqual(expect.any(String));
        expect(await rotation).not.toBe('account-a');
        expect(value.attempts).toEqual(['a', 'b']);
        expect(value.manager.providerStatus[TYPE][1].config.isHealthy).toBe(true);
    });

    test.each(['stream', 'unary'])('%s still avoids an earlier failed account if it rotates during the next switch delay', async mode => {
        const value = await fixture(['a', 'b', 'c'], name => name !== 'c' ? upstreamUnavailable() : null);
        let waits = 0, rotation;
        logger.info.mockImplementation(message => {
            if (!String(message).includes('Waiting 100ms before retry') || ++waits !== 2) return;
            rotation = new Promise(resolve => setTimeout(() => resolve(
                value.manager.refreshProviderUuid(TYPE, { uuid: 'account-a' })), 0));
        });
        await value.run(mode);
        expect(rotation).toBeInstanceOf(Promise);
        expect(await rotation).toEqual(expect.any(String));
        expect(await rotation).not.toBe('account-a');
        expect(value.attempts).toEqual(['a', 'b', 'c']);
    });

    test.each(['stream', 'unary'])('%s preserves earlier failed account identities in same-body retries', async mode => {
        const value = await fixture(['a', 'b', 'c'], (name, attempt) => name === 'a' ? upstreamUnavailable()
            : name === 'b' && attempt === 1 ? createEmptyUpstreamResponseError('Kiro') : null);
        let rotation;
        logger.warn.mockImplementation(message => {
            if (rotation || !String(message).includes('Retrying with the same request body')) return;
            rotation = new Promise(resolve => setTimeout(() => resolve(
                value.manager.refreshProviderUuid(TYPE, { uuid: 'account-a' })), 0));
        });
        await value.run(mode);
        expect(rotation).toBeInstanceOf(Promise);
        expect(await rotation).toEqual(expect.any(String));
        expect(await rotation).not.toBe('account-a');
        // The first empty-response replay keeps b eligible; LRU chooses c once a is avoided.
        expect(value.attempts).toEqual(['a', 'b', 'c']);
    });

    test.each(['stream', 'unary'])('%s can reuse the rotated account when no alternate exists', async mode => {
        const value = await fixture(['a'], (name, attempt) => attempt === 1 ? upstreamUnavailable() : null);
        let rotation;
        logger.info.mockImplementation(message => {
            if (rotation || !String(message).includes('Waiting 5ms before retry')) return;
            rotation = new Promise(resolve => setTimeout(() => resolve(
                value.manager.refreshProviderUuid(TYPE, { uuid: 'account-a' })), 0));
        });
        await value.run(mode);
        expect(rotation).toBeInstanceOf(Promise);
        expect(await rotation).toEqual(expect.any(String));
        expect(await rotation).not.toBe('account-a');
        expect(value.attempts).toEqual(['a', 'a']);
    });

    test.each([false, true])('resolves lease identities after waiting for the selection lock (dryRun=%s)', async dryRun => {
        const value = await fixture(['a', 'b']);
        value.initial.slotLease.release();
        const options = { kiroSession: SESSION, preferOtherUuids: ['account-a'],
            preferOtherLeases: [value.initial.slotLease], dryRun };
        value.manager._isSelecting[TYPE] = true;
        const pending = value.manager.selectProvider(TYPE, MODEL, options);
        await tick();
        const rotated = value.manager.refreshProviderUuid(TYPE, { uuid: 'account-a' });
        value.manager._isSelecting[TYPE] = false;
        const selected = await pending;
        expect(rotated).not.toBe('account-a');
        expect(selected.customName).toBe('b');
        expect(value.manager.providerStatus[TYPE].every(provider => provider.state.activeCount === 0)).toBe(true);
    });

});
