import { EventEmitter, getEventListeners } from 'node:events';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import { handleStreamRequest, handleUnaryRequest, handleContentGenerationRequest, ENDPOINT_TYPE } from '../src/utils/common.js';
import '../src/converters/register-converters.js';
import { acquireProviderSlot } from '../src/providers/provider-slot-lease.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import * as services from '../src/services/service-manager.js';
import logger from '../src/utils/logger.js';
import { performance } from 'node:perf_hooks';

const KIRO = 'claude-kiro-oauth';
const MODEL = 'claude-sonnet-4-5';
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const body = () => ({ messages: [{ role: 'user', content: 'hello' }] });
const textChunk = () => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } });
const startChunk = () => ({ type: 'message_start', message: {
    id: 'msg-test', type: 'message', role: 'assistant', model: MODEL, content: [],
    usage: { input_tokens: 1, output_tokens: 0 }, stop_reason: null, stop_sequence: null
} });

function response(stalls = () => false) {
    const res = new EventEmitter();
    Object.assign(res, { writableEnded: false, destroyed: false, writableNeedDrain: false, headersSent: false });
    res.writeHead = jest.fn(() => { res.headersSent = true; });
    res.flushHeaders = jest.fn();
    res.write = jest.fn(chunk => {
        const blocked = stalls(chunk);
        if (blocked) res.writableNeedDrain = true;
        return !blocked;
    });
    res.end = jest.fn(() => { res.writableEnded = true; });
    res.destroy = jest.fn(() => {
        if (res.destroyed) return;
        res.destroyed = true;
        res.emit('close');
    });
    return res;
}

function pool() {
    return {
        releaseSlot: jest.fn(), markProviderHealthy: jest.fn(), markProviderUnhealthy: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn(), markProviderNeedRefresh: jest.fn()
    };
}

function assertNoProviderPenalty(manager) {
    expect(manager.markProviderUnhealthy).not.toHaveBeenCalled();
    expect(manager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
    expect(manager.markProviderNeedRefresh).not.toHaveBeenCalled();
}

async function settles(operation, res) {
    let timer, completed = false;
    try {
        const result = await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Public Kiro handler did not settle after its write deadline')), 700);
            })
        ]);
        completed = true;
        return result;
    } finally {
        clearTimeout(timer);
        // Also close a failed pre-fix run so it cannot leave a pending drain.
        if (!completed && !res.writableEnded && !res.destroyed) res.destroy();
    }
}

async function waitsForDeadline(operation, res) {
    let completed = false;
    const tracked = operation.then(result => { completed = true; return result; });
    await tick();
    const completedBeforeDeadline = completed;
    await settles(tracked, res);
    expect(completedBeforeDeadline).toBe(false);
    expect(res.destroyed || res.writableEnded).toBe(true);
}

function runStream(res, backend, manager, extra = {}) {
    return handleStreamRequest(res, backend, MODEL, body(), 'claude', KIRO, 'none', null, manager, 'node', null, {
        maxRetries: 0,
        CONFIG: { KIRO_DOWNSTREAM_WRITE_TIMEOUT_MS: 20, SSE_HEARTBEAT_INTERVAL_MS: 0 },
        ...extra
    });
}

describe('Kiro public stream handler write deadlines', () => {
    afterEach(() => jest.restoreAllMocks());

    test('each combined SSE event preserves exact bytes and waits for drain before fetching more', async () => {
        const chunks = [startChunk(), textChunk(), { type: 'message_stop' }];
        let consumed = 0, first = true;
        const res = response(() => { if (!first) return false; first = false; return true; });
        const backend = { generateContentStream: async function* () {
            for (const chunk of chunks) { consumed++; yield chunk; }
        } };
        const pending = runStream(res, backend, pool(), {
            CONFIG: { KIRO_DOWNSTREAM_WRITE_TIMEOUT_MS: 500, SSE_HEARTBEAT_INTERVAL_MS: 0 }
        });
        try {
            await tick();
            expect(consumed).toBe(1);
            expect(res.write.mock.calls).toEqual([[`event: message_start\ndata: ${JSON.stringify(chunks[0])}\n\n`]]);
            res.writableNeedDrain = false; res.emit('drain');
            await settles(pending, res);
            expect(res.write.mock.calls.map(([value]) => value)).toEqual(chunks.map(chunk => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`));
            expect(consumed).toBe(3);
        } finally {
            if (!res.writableEnded && !res.destroyed) res.destroy();
            await pending;
        }
    });

    test.each(['event', 'data'])('a stalled %s record cancels upstream and frees its actual lease without fetching another event', async kind => {
        const node = { type: KIRO, config: { uuid: 'node', concurrencyLimit: 1, isHealthy: true }, state: { activeCount: 0, waitingCount: 0, queue: [] } };
        const acquired = await acquireProviderSlot(node);
        const manager = pool();
        const res = response(chunk => chunk.split('\n').some(line => line.startsWith(`${kind}:`)));
        let signal, closed = false, consumed = 0;
        const backend = { generateContentStream: async function* (_, __, options) {
            signal = options.signal;
            try {
                consumed++; yield startChunk();
                consumed++; yield textChunk();
            } finally { closed = true; }
        } };
        await settles(runStream(res, backend, manager, { slotLease: acquired._slotLease }), res);
        expect(signal.aborted).toBe(true);
        expect(res.destroyed || res.writableEnded).toBe(true);
        expect(consumed).toBe(1);
        expect(closed).toBe(true);
        expect(node.state.activeCount).toBe(0);
        expect(acquired._slotLease.released).toBe(true);
        expect(manager.releaseSlot).not.toHaveBeenCalled();
        expect(manager.markProviderHealthy).not.toHaveBeenCalled();
        assertNoProviderPenalty(manager);
        expect(res.listenerCount('drain')).toBe(0);
        expect(res.listenerCount('close')).toBe(0);
        expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    });

    test('a stalled heartbeat cancels an awaiting generator and releases its slot', async () => {
        const manager = pool(), res = response(chunk => chunk.startsWith(': keep-alive'));
        let signal, closed = false;
        const backend = { generateContentStream: async function* (_, __, options) {
            signal = options.signal;
            try {
                await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
            } finally { closed = true; }
        } };
        await settles(runStream(res, backend, manager, {
            CONFIG: { KIRO_DOWNSTREAM_WRITE_TIMEOUT_MS: 20, SSE_HEARTBEAT_INTERVAL_MS: 5 }
        }), res);
        expect(res.write.mock.calls.some(([chunk]) => chunk.startsWith(': keep-alive'))).toBe(true);
        expect(signal.aborted).toBe(true);
        expect(res.destroyed || res.writableEnded).toBe(true);
        expect(closed).toBe(true);
        expect(manager.releaseSlot).toHaveBeenCalledTimes(1);
        expect(manager.markProviderHealthy).not.toHaveBeenCalled();
        assertNoProviderPenalty(manager);
    });

    test.each(['before content', 'after content'])('a stalled error payload %s still has a deadline', async stage => {
        const manager = pool(), res = response(chunk => chunk.includes('"error"') || chunk.startsWith('event: error'));
        let signal, closed = false;
        const backend = { generateContentStream: async function* (_, __, options) {
            signal = options.signal;
            try {
                if (stage === 'after content') yield textChunk();
                const error = Object.assign(new Error('bad request'), { status: 400, response: { status: 400 }, skipErrorCount: true });
                throw error;
            } finally { closed = true; }
        } };
        await waitsForDeadline(runStream(res, backend, manager), res);
        expect(signal.aborted).toBe(true);
        expect(closed).toBe(true);
        expect(manager.releaseSlot).toHaveBeenCalledTimes(1);
        assertNoProviderPenalty(manager);
        expect(res.listenerCount('drain')).toBe(0);
    });

    test.each(['event', 'data'])('a stalled synthesized Claude terminal %s cannot keep the handler open', async kind => {
        const manager = pool();
        const res = response(chunk => chunk.split('\n').includes(kind === 'event' ? 'event: message_stop' : 'data: {"type":"message_stop"}'));
        const backend = { generateContentStream: async function* () { yield textChunk(); } };
        await waitsForDeadline(runStream(res, backend, manager), res);
        expect(manager.releaseSlot).toHaveBeenCalledTimes(1);
        assertNoProviderPenalty(manager);
        expect(res.listenerCount('drain')).toBe(0);
    });

    test('a stalled OpenAI DONE marker cannot keep a converted Kiro stream open', async () => {
        const manager = pool(), res = response(chunk => chunk === 'data: [DONE]\n\n');
        const backend = { generateContentStream: async function* () {
            yield startChunk();
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
            yield textChunk();
            yield { type: 'content_block_stop', index: 0 };
            yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } };
            yield { type: 'message_stop' };
        } };
        const pending = handleStreamRequest(res, backend, MODEL, body(), 'openai', KIRO, 'none', null, manager, 'node', null, {
            maxRetries: 0, CONFIG: { KIRO_DOWNSTREAM_WRITE_TIMEOUT_MS: 20, SSE_HEARTBEAT_INTERVAL_MS: 0 }
        });
        await waitsForDeadline(pending, res);
        expect(res.write.mock.calls.map(([chunk]) => chunk)).toEqual(expect.arrayContaining(['data: [DONE]\n\n']));
        expect(manager.releaseSlot).toHaveBeenCalledTimes(1);
        assertNoProviderPenalty(manager);
        expect(res.listenerCount('drain')).toBe(0);
    });

    test('the Kiro write timeout setting does not impose a deadline on another provider', async () => {
        const manager = pool(); let signal, completed = false, first = true;
        const res = response(() => { if (!first) return false; first = false; return true; });
        const backend = { generateContentStream: async function* (_, __, options) {
            signal = options.signal;
            yield { choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] };
        } };
        const pending = handleStreamRequest(res, backend, 'model', {}, 'openai', 'openai-custom', 'none', null, manager, 'node', null, {
            CONFIG: { KIRO_DOWNSTREAM_WRITE_TIMEOUT_MS: 10, SSE_HEARTBEAT_INTERVAL_MS: 0 }
        }).then(() => { completed = true; });
        try {
            await delay(35);
            expect(completed).toBe(false);
            expect(signal.aborted).toBe(false);
            res.writableNeedDrain = false; res.emit('drain');
            await settles(pending, res);
            expect(manager.markProviderHealthy).toHaveBeenCalledTimes(1);
        } finally {
            if (!res.writableEnded && !res.destroyed) res.destroy();
            await pending;
        }
    });
});

describe('Kiro request timing covers account selection', () => {
    afterEach(() => jest.restoreAllMocks());

    test('a queued selection remains in the shared baseline through the first accepted text', async () => {
        logger.info.mockClear();
        const req = new EventEmitter(), res = response(); req.headers = {};
        let enterSelection, finishSelection, options, sentBody;
        const entered = new Promise(resolve => { enterSelection = resolve; });
        const gate = new Promise(resolve => { finishSelection = resolve; });
        const backend = { generateContentStream: async function* (_, body, received) {
            options = received; sentBody = body;
            yield startChunk(); yield textChunk(); yield { type: 'message_stop' };
        } };
        jest.spyOn(services, 'getApiServiceWithFallback').mockImplementation(async () => {
            enterSelection(); await gate;
            return { service: backend, actualProviderType: KIRO, uuid: 'node' };
        });
        const before = performance.now();
        const pending = handleContentGenerationRequest(req, res, null, ENDPOINT_TYPE.CLAUDE_MESSAGE,
            { MODEL_PROVIDER: KIRO, PROMPT_LOG_MODE: 'none', SSE_HEARTBEAT_INTERVAL_MS: 0 }, null, pool(), null);
        req.emit('data', Buffer.from(JSON.stringify({ model: MODEL, ...body(), stream: true })));
        req.emit('end');
        await entered;
        const waitStarted = performance.now();
        await delay(25);
        const waitedMs = performance.now() - waitStarted;
        finishSelection();
        await settles(pending, res);
        expect(options.kiroTiming.startedAt).toBeGreaterThanOrEqual(before);
        expect(options.kiroTiming.startedAt).toBeLessThanOrEqual(waitStarted);
        expect(sentBody).not.toHaveProperty('kiroTiming');
        const logs = logger.info.mock.calls.map(([message]) => message).filter(message => message.startsWith('[Kiro Timing]'));
        const preparation = logs.find(message => message.includes('Request preparation:'));
        expect(Number(preparation.match(/account selection: (\d+)ms/)[1])).toBeGreaterThanOrEqual(Math.floor(waitedMs));
        expect(logs.filter(message => message.includes('First downstream event accepted:'))).toHaveLength(1);
        const textLogs = logs.filter(message => message.includes('First downstream text accepted:'));
        expect(textLogs).toHaveLength(1);
        expect(Number(textLogs[0].match(/accepted: (\d+)ms/)[1])).toBeGreaterThanOrEqual(Math.floor(waitedMs));
        expect(logs.join(' ')).not.toContain('hello');
    });
});

describe('Kiro retry configuration reaches public handlers', () => {
    afterEach(() => jest.restoreAllMocks());

    test.each(['stream', 'unary'])('%s cooldown preserves Kiro Retry-After and retains the non-Kiro cap', async mode => {
        const now = 1800000000000;
        jest.spyOn(Date, 'now').mockReturnValue(now);
        for (const provider of [KIRO, 'openai-custom']) {
            const manager = pool(), res = response();
            const error = Object.assign(new Error('rate limited'), {
                response: { status: 429, headers: { 'retry-after': '120' } }, skipErrorCount: true, shouldSwitchCredential: true
            });
            const backend = {
                generateContentStream: async function* () { throw error; },
                generateContent: async () => { throw error; }
            };
            const config = { RATE_LIMIT_COOLDOWN_ENABLED: true, RATE_LIMIT_COOLDOWN_MS: 100, RATE_LIMIT_COOLDOWN_MAX_MS: 1000,
                RATE_LIMIT_COOLDOWN_JITTER_MS: 0, SSE_HEARTBEAT_INTERVAL_MS: 0 };
            const handler = mode === 'stream' ? handleStreamRequest : handleUnaryRequest;
            await handler(res, backend, MODEL, body(), provider === KIRO ? 'claude' : 'openai', provider, 'none', null, manager, 'node', null, { maxRetries: 0, CONFIG: config });
            const recovery = manager.markProviderUnhealthyWithRecoveryTime.mock.calls[0][3];
            expect(recovery.getTime() - now).toBe(provider === KIRO ? 120000 : 1000);
            expect(manager.markProviderUnhealthy).not.toHaveBeenCalled();
        }
    });

    test.each(['stream', 'unary'])('%s request routing honors zero Kiro credential switches without changing other providers', async mode => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        for (const provider of [KIRO, 'openai-custom']) {
            const manager = pool(), req = new EventEmitter(), res = response(); req.headers = {};
            const error = Object.assign(new Error('upstream unavailable'), {
                response: { status: 503 }, skipErrorCount: true, shouldSwitchCredential: true
            });
            const failure = { generateContentStream: async function* () { throw error; }, generateContent: async () => { throw error; } };
            const fallback = { generateContentStream: async function* () { yield { choices: [{ delta: { content: 'fallback' }, finish_reason: 'stop' }] }; },
                generateContent: async () => ({ choices: [{ message: { role: 'assistant', content: 'fallback' }, finish_reason: 'stop' }] }) };
            const select = jest.spyOn(services, 'getApiServiceWithFallback').mockResolvedValue({ service: fallback, actualProviderType: 'openai-custom', uuid: 'fallback' });
            const config = { MODEL_PROVIDER: provider, CREDENTIAL_SWITCH_MAX_RETRIES: 0, PROMPT_LOG_MODE: 'none', SSE_HEARTBEAT_INTERVAL_MS: 0 };
            const pending = handleContentGenerationRequest(req, res, failure, provider === KIRO ? ENDPOINT_TYPE.CLAUDE_MESSAGE : ENDPOINT_TYPE.OPENAI_CHAT,
                config, null, manager, 'node');
            req.emit('data', Buffer.from(JSON.stringify({ model: MODEL, ...body(), stream: mode === 'stream' })));
            req.emit('end');
            await settles(pending, res);
            expect(select).toHaveBeenCalledTimes(provider === KIRO ? 0 : 1);
            select.mockRestore();
        }
    });
});

describe('Kiro acquired account identity survives UUID rotation', () => {
    afterEach(() => jest.restoreAllMocks());

    test.each(['stream', 'unary'])('%s cannot send an old selected account after its UUID rotates and it is suspended', async mode => {
        class MemoryPool extends ProviderPoolManager {
            _debouncedSave() {}
            _log() {}
            _logHealthStatusChange() {}
        }
        const manager = new MemoryPool({ [KIRO]: [{ uuid: 'old', isHealthy: true, concurrencyLimit: 1, queueLimit: 5 }] });
        const node = manager.providerStatus[KIRO][0];
        const selected = await acquireProviderSlot(node);
        const oldUuid = selected.uuid;
        const newUuid = manager.refreshProviderUuid(KIRO, { uuid: oldUuid });
        manager.markProviderUnhealthyImmediately(KIRO, { uuid: newUuid }, '403 temporarily suspended');
        const backend = {
            generateContentStream: jest.fn(async function* () { yield textChunk(); }),
            generateContent: jest.fn(async () => ({ role: 'assistant', content: [{ type: 'text', text: 'unexpected send' }] }))
        };
        const res = response();
        const markHealthy = jest.spyOn(manager, 'markProviderHealthy');
        const handler = mode === 'stream' ? handleStreamRequest : handleUnaryRequest;
        await handler(res, backend, MODEL, body(), 'claude', KIRO, 'none', null, manager, oldUuid, null, {
            slotLease: selected._slotLease,
            CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 0, SSE_HEARTBEAT_INTERVAL_MS: 0 }
        });
        expect(backend.generateContentStream).not.toHaveBeenCalled();
        expect(backend.generateContent).not.toHaveBeenCalled();
        expect(markHealthy).not.toHaveBeenCalled();
        expect(node.config.kiroAccountSuspended).toBe(true);
        expect(node.config.isHealthy).toBe(false);
        expect(node.state.activeCount).toBe(0);
    });
});
