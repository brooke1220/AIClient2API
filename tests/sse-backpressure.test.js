import { EventEmitter, getEventListeners } from 'node:events';
import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import { writeWithBackpressure } from '../src/utils/stream-lifecycle.js';
import { handleStreamRequest, handleContentGenerationRequest, ENDPOINT_TYPE } from '../src/utils/common.js';
import * as services from '../src/services/service-manager.js';
import { response, tick } from './helpers/kiro-safety-fixtures.js';

describe('SSE backpressure and early routing cancellation', () => {
    afterEach(() => jest.restoreAllMocks());
    test('writing pauses until drain and removes its temporary listeners', async () => {
        const res = response(); res.write.mockReturnValue(false); let completed = false;
        const pending = writeWithBackpressure(res, 'data: x\n\n').then(() => { completed = true; });
        await tick(); expect(completed).toBe(false); res.emit('drain'); await pending;
        expect(res.listenerCount('drain')).toBe(0); expect(res.listenerCount('close')).toBe(0);
    });
    test.each(['abort', 'close', 'error'])('%s interrupts a pending drain without leaking listeners', async failure => {
        const res = response(); res.write.mockReturnValue(false); const controller = new AbortController();
        const pending = writeWithBackpressure(res, 'data: x\n\n', controller.signal);
        if (failure === 'abort') controller.abort(); else res.emit(failure, new Error('closed'));
        await expect(pending).rejects.toBeDefined();
        expect(res.listenerCount('drain')).toBe(0); expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });
    test('the common handler does not consume a second token until the first drains', async () => {
        let consumed = 0;
        const backend = { generateContentStream: async function* () { consumed++; yield { choices: [{ delta: { content: 'a' } }] }; consumed++; yield { choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }] }; } };
        const res = response(); res.write.mockReturnValueOnce(false);
        const pending = handleStreamRequest(res, backend, 'mock', {}, 'openai', 'openai-custom', 'none', null, null, null, null, { CONFIG: {} });
        await tick(); expect(consumed).toBe(1); res.emit('drain'); await pending;
        expect(consumed).toBe(2); expect(res.end).toHaveBeenCalledTimes(1);
    });
    test('an interrupted stream is not counted as a completed provider request', async () => {
        const res = response(); const pool = { releaseSlot: jest.fn(), markProviderHealthy: jest.fn() };
        const backend = { generateContentStream: async function* () {
            yield { choices: [{ delta: { content: 'prefix' } }] };
            res.emit('close'); yield { choices: [{ delta: { content: 'not sent' } }] };
        } };
        await handleStreamRequest(res, backend, 'mock', {}, 'openai', 'openai-custom', 'none', null, pool, 'node', null, { CONFIG: {} });
        expect(pool.markProviderHealthy).not.toHaveBeenCalled(); expect(pool.releaseSlot).toHaveBeenCalledTimes(1);
    });
    test('heartbeat comments do not turn empty output into success', async () => {
        const res = response(); res.headersSent = true;
        const backend = { generateContentStream: async function* () { await new Promise(resolve => setTimeout(resolve, 20)); } };
        await handleStreamRequest(res, backend, 'mock', {}, 'openai', 'openai-custom', 'none', null, null, null, null, { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 0, SSE_HEARTBEAT_INTERVAL_MS: 5 } });
        expect(res.write.mock.calls.some(([text]) => text.startsWith(': keep-alive'))).toBe(true);
        expect(res.write.mock.calls.some(([text]) => text.includes('error'))).toBe(true);
    });
    test('client disconnect cancels account selection before the stream handler exists', async () => {
        const req = new EventEmitter(); req.headers = {}; req.resume = jest.fn();
        const res = response(); let signal;
        const select = jest.spyOn(services, 'getApiServiceWithFallback').mockImplementation(async (_, __, options) => {
            signal = options.signal;
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        });
        const pending = handleContentGenerationRequest(req, res, null, ENDPOINT_TYPE.CLAUDE_MESSAGE, { MODEL_PROVIDER: 'claude-kiro-oauth', PROMPT_LOG_MODE: 'none' }, null, null, null);
        req.emit('data', Buffer.from('{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hello"}],"stream":true}')); req.emit('end');
        for (let n = 0; !signal && n < 20; n++) await tick();
        expect(select).toHaveBeenCalled(); res.destroyed = true; res.emit('close'); await pending;
        expect(signal.aborted).toBe(true); expect(res.listenerCount('close')).toBe(0);
    });
    test('a retry releases its prior lease before acquiring another slot', async () => {
        const release = jest.fn();
        const fallback = jest.spyOn(services, 'getApiServiceWithFallback').mockImplementation(async () => {
            expect(release).toHaveBeenCalledTimes(1);
            return { service: { generateContentStream: async function* () { yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }; } }, actualProviderType: 'openai-custom', slotLease: { release: jest.fn() } };
        });
        const backend = { generateContentStream: async function* () { const error = new Error('empty'); error.isEmptyUpstreamResponse = true; throw error; } };
        await handleStreamRequest(response(), backend, 'mock', {}, 'openai', 'openai-custom', 'none', null, null, null, null, { slotLease: { release }, CONFIG: { EMPTY_RESPONSE_RETRY_DELAY_MS: 0 } });
        expect(fallback).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
    });
});
