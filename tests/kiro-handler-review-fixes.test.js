import { EventEmitter, getEventListeners } from 'node:events';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import { handleStreamRequest, handleUnaryRequest, handleContentGenerationRequest, ENDPOINT_TYPE,
    getRequestBody, createEmptyUpstreamResponseError } from '../src/utils/common.js';
import { kiroIntegrityError } from '../src/providers/claude/kiro-event-stream.js';
import { applyKiroStreamExceptionPolicy } from '../src/providers/claude/kiro-error-policy.js';
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

describe('CC endpoint streaming contract', () => {
    afterEach(() => jest.restoreAllMocks());

    test.each([false, true])('public CC endpoint forwards configured buffering=%s and scoped session context', async buffered => {
        const req = new EventEmitter(), res = response();
        req.headers = { 'x-api-key': 'test-client-key' }; req.url = '/cc/v1/messages';
        let sentBody, options;
        const backend = { generateContentStream: async function* (_, requestBody, received) {
            sentBody = requestBody; options = received;
            yield startChunk(); yield textChunk(); yield { type: 'message_stop' };
        } };
        const pending = handleContentGenerationRequest(req, res, backend, ENDPOINT_TYPE.CLAUDE_CC_MESSAGE,
            { MODEL_PROVIDER: KIRO, PROMPT_LOG_MODE: 'none', SSE_HEARTBEAT_INTERVAL_MS: 0,
                ...(buffered ? { KIRO_CC_BUFFERED: true } : {}) }, null, null, null);
        req.emit('data', Buffer.from(JSON.stringify({ model: MODEL, ...body(), stream: true })));
        req.emit('end');
        await settles(pending, res);
        expect(sentBody).toMatchObject({ _ccBuffered: buffered, _ccEndpoint: true });
        expect(options.kiroSession.key).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(options.kiroSession)).not.toContain('test-client-key');
    });

    test.each(['stream', 'unary'])('classified failures expose Retry-After through the %s response', async mode => {
        const error = Object.assign(new Error('Model temporarily unavailable'), {
            status: 503, code: 'KIRO_MODEL_UNAVAILABLE', kiroErrorKind: 'model_unavailable', skipErrorCount: true,
            shouldSwitchCredential: false, response: { status: 503, headers: { 'retry-after': '17' } }
        });
        const backend = { generateContent: async () => { throw error; }, generateContentStream: async function* () { throw error; } };
        const res = response(), manager = pool();
        if (mode === 'stream') {
            await runStream(res, backend, manager);
            expect(res.write.mock.calls.flat().join('')).toContain('"retry_after":"17"');
            expect(res.write.mock.calls.flat().join('')).toContain('"status":503');
        } else {
            await handleUnaryRequest(res, backend, MODEL, body(), 'claude', KIRO, 'none', null, manager, 'node', null,
                { CONFIG: {}, currentRetry: 0, maxRetries: 0 });
            expect(res.writeHead).toHaveBeenCalledWith(503, expect.objectContaining({ 'Retry-After': '17' }));
        }
        assertNoProviderPenalty(manager);
    });
});

describe('error status precedence', () => {
    afterEach(() => jest.restoreAllMocks());

    test.each(['stream', 'unary'])('a provider-remapped status wins over the raw response status in the %s response', async mode => {
        // Qwen maps a daily-quota 403 to 429 while retaining the raw response.
        const error = Object.assign(new Error('quota exhausted'), { status: 429, skipErrorCount: true,
            response: { status: 403, headers: {} } });
        const backend = { generateContent: async () => { throw error; }, generateContentStream: async function* () { throw error; } };
        const res = response(), manager = pool();
        if (mode === 'stream') {
            await handleStreamRequest(res, backend, MODEL, body(), 'claude', 'openai-qwen-oauth', 'none', null, manager, 'node', null,
                { CONFIG: {}, currentRetry: 0, maxRetries: 0 });
            expect(res.write.mock.calls.flat().join('')).toContain('"type":"rate_limit_error"');
        } else {
            await handleUnaryRequest(res, backend, MODEL, body(), 'claude', 'openai-qwen-oauth', 'none', null, manager, 'node', null,
                { CONFIG: {}, currentRetry: 0, maxRetries: 0 });
            expect(res.writeHead).toHaveBeenCalledWith(429, expect.any(Object));
            expect(JSON.parse(res.end.mock.calls[0][0]).error.type).toBe('rate_limit_error');
        }
    });

    test('an Axios-style error without a numeric status uses its response status', async () => {
        const error = Object.assign(new Error('Request failed with status code 429'), { code: 'ERR_BAD_RESPONSE',
            skipErrorCount: true, response: { status: 429, headers: { 'retry-after': '9' } } });
        const backend = { generateContent: async () => { throw error; } };
        const res = response();
        await handleUnaryRequest(res, backend, MODEL, body(), 'claude', 'openai-qwen-oauth', 'none', null, pool(), 'node', null,
            { CONFIG: {}, currentRetry: 0, maxRetries: 0 });
        expect(res.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({ 'Retry-After': '9' }));
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

describe('Kiro model rejection follows the in-flight account identity', () => {
    afterEach(() => jest.restoreAllMocks());

    class MemoryPool extends ProviderPoolManager {
        _debouncedSave() {}
        _log() {}
        _logHealthStatusChange() {}
    }

    const createPool = () => new MemoryPool({ [KIRO]: [{
        uuid: 'account', isHealthy: true, concurrencyLimit: 1,
        KIRO_OAUTH_CREDS_FILE_PATH: '/mock/original-account.json'
    }] }, { globalConfig: {} });

    const startRejectedRequest = (mode, manager, selected) => {
        let enter, finish;
        const entered = new Promise(resolve => { enter = resolve; });
        const complete = new Promise(resolve => { finish = resolve; });
        const fail = async () => {
            enter();
            await complete;
            throw Object.assign(new Error('402 with trial credits remaining'), {
                response: { status: 402 }, quotaExhausted: true, kiroModelRejected: true,
                shouldSwitchCredential: true, skipErrorCount: true
            });
        };
        const backend = {
            generateContentStream: async function* () { await fail(); },
            generateContent: fail
        };
        const res = response();
        const handler = mode === 'stream' ? handleStreamRequest : handleUnaryRequest;
        const pending = handler(res, backend, MODEL, body(), 'claude', KIRO, 'none', null,
            manager, selected.uuid, null, {
                slotLease: selected._slotLease,
                CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 0, SSE_HEARTBEAT_INTERVAL_MS: 0 }
            });
        return { entered, finish, pending, res };
    };

    test.each(['stream', 'unary'])('%s cools the rejected model after another request rotates the account UUID', async mode => {
        const manager = createPool();
        const node = manager.providerStatus[KIRO][0];
        const selected = await acquireProviderSlot(node);
        const attempt = startRejectedRequest(mode, manager, selected);
        await attempt.entered;

        const currentUuid = manager.refreshProviderUuid(KIRO, { uuid: selected.uuid });
        expect(currentUuid).not.toBe(selected.uuid);
        attempt.finish();
        await settles(attempt.pending, attempt.res);

        await expect(manager.selectProvider(KIRO, MODEL)).resolves.toBeNull();
        await expect(manager.selectProvider(KIRO, 'claude-haiku-4-5')).resolves.toMatchObject({ uuid: currentUuid });
        expect(node.config.isHealthy).toBe(true);
        expect(selected._slotLease.released).toBe(true);
        expect(node.state.activeCount).toBe(0);
        expect(node.state.waitingCount).toBe(0);
    });

    test.each(['stream', 'unary'])('%s does not apply an old request rejection to replacement credentials with the same UUID', async mode => {
        const manager = createPool();
        const node = manager.providerStatus[KIRO][0];
        const selected = await acquireProviderSlot(node);
        const attempt = startRejectedRequest(mode, manager, selected);
        await attempt.entered;

        manager.providerPools[KIRO][0] = {
            ...node.config, KIRO_OAUTH_CREDS_FILE_PATH: '/mock/replacement-account.json'
        };
        manager.initializeProviderStatus(true);
        const replacement = manager.providerStatus[KIRO][0];
        expect(replacement.state).toBe(node.state);
        expect(replacement.state.activeCount).toBe(1);
        attempt.finish();
        await settles(attempt.pending, attempt.res);

        await expect(manager.selectProvider(KIRO, MODEL)).resolves.toMatchObject({ uuid: selected.uuid });
        await expect(manager.selectProvider(KIRO, 'claude-haiku-4-5')).resolves.toMatchObject({ uuid: selected.uuid });
        expect(replacement.config.isHealthy).toBe(true);
        expect(selected._slotLease.released).toBe(true);
        expect(replacement.state.activeCount).toBe(0);
        expect(replacement.state.waitingCount).toBe(0);
    });

    test.each(['stream', 'unary'])('%s preserves the credential scope captured by the acquired slot before the handler starts', async mode => {
        const manager = createPool();
        const selected = await manager.acquireSlot(KIRO, MODEL);
        const node = manager.providerStatus[KIRO][0];

        manager.providerPools[KIRO][0] = {
            ...node.config, KIRO_OAUTH_CREDS_FILE_PATH: '/mock/replacement-before-handler.json'
        };
        manager.initializeProviderStatus(true);
        const replacement = manager.providerStatus[KIRO][0];
        expect(replacement.state).toBe(node.state);
        expect(replacement.state.activeCount).toBe(1);

        const attempt = startRejectedRequest(mode, manager, selected);
        await attempt.entered;
        attempt.finish();
        await settles(attempt.pending, attempt.res);

        await expect(manager.selectProvider(KIRO, MODEL)).resolves.toMatchObject({ uuid: selected.uuid });
        expect(replacement.config.isHealthy).toBe(true);
        expect(selected._slotLease.released).toBe(true);
        expect(replacement.state.activeCount).toBe(0);
        expect(replacement.state.waitingCount).toBe(0);
    });

    test.each(['stream', 'unary'])('%s switches away from the current UUID after an in-flight account rotation and 503', async mode => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const select = jest.spyOn(services, 'getApiServiceWithFallback').mockResolvedValue(null);
        const manager = createPool();
        const selected = await manager.acquireSlot(KIRO, MODEL);
        const node = manager.providerStatus[KIRO][0];
        let enter, finish;
        const entered = new Promise(resolve => { enter = resolve; });
        const complete = new Promise(resolve => { finish = resolve; });
        const fail = async () => {
            enter();
            await complete;
            throw Object.assign(new Error('upstream unavailable'), {
                response: { status: 503 }, shouldSwitchCredential: true, skipErrorCount: true
            });
        };
        const backend = {
            generateContentStream: async function* () { await fail(); },
            generateContent: fail
        };
        const res = response();
        const handler = mode === 'stream' ? handleStreamRequest : handleUnaryRequest;
        const pending = handler(res, backend, MODEL, body(), 'claude', KIRO, 'none', null,
            manager, selected.uuid, null, {
                slotLease: selected._slotLease,
                CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 1, SSE_HEARTBEAT_INTERVAL_MS: 0 }
            });
        await entered;
        const currentUuid = manager.refreshProviderUuid(KIRO, { uuid: selected.uuid });
        finish();
        await settles(pending, res);

        expect(select).toHaveBeenCalledTimes(1);
        expect(select.mock.calls[0][2].preferOtherUuids).toEqual([currentUuid]);
        expect(select.mock.calls[0][2].preferOtherUuids).not.toContain(selected.uuid);
        expect(selected._slotLease.released).toBe(true);
        expect(node.state.activeCount).toBe(0);
        expect(node.state.waitingCount).toBe(0);
    });
});

describe('request bodies decode UTF-8 once, across chunk boundaries', () => {
    test('multi-byte characters split between chunks survive intact', async () => {
        const req = new EventEmitter(); req.headers = {};
        const payload = { messages: [{ role: 'user', content: '中文测试 🟢 émoji' }] };
        const pending = getRequestBody(req);
        // One byte per chunk splits every multi-byte character.
        for (const byte of Buffer.from(JSON.stringify(payload))) req.emit('data', Buffer.from([byte]));
        req.emit('end');
        await expect(pending).resolves.toEqual(payload);
    });
});

describe('Kiro retry account selection matches the failure type', () => {
    afterEach(() => jest.restoreAllMocks());
    const session = { key: 'session-key' };
    const failing = error => ({
        generateContentStream: async function* () { throw error; },
        generateContent: async () => { throw error; }
    });
    const succeeding = () => ({
        generateContentStream: async function* () { yield startChunk(); yield textChunk(); yield { type: 'message_stop' }; },
        generateContent: async () => ({ id: 'msg', type: 'message', role: 'assistant', model: MODEL,
            content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    });
    const streamException = (type, reason) => applyKiroStreamExceptionPolicy(kiroIntegrityError('upstream exception'), type, reason);
    const run = async (mode, service, manager, retryContext) => {
        const res = response();
        await (mode === 'stream' ? handleStreamRequest : handleUnaryRequest)(
            res, service, MODEL, body(), 'claude', KIRO, 'none', null, manager, 'failed-node', null,
            { CONFIG: { SSE_HEARTBEAT_INTERVAL_MS: 0, EMPTY_RESPONSE_RETRY_DELAY_MS: 0 }, kiroSession: session, ...retryContext });
        return res;
    };
    const selectNext = uuid => jest.spyOn(services, 'getApiServiceWithFallback').mockResolvedValue({ service: succeeding(), actualProviderType: KIRO, uuid });

    test.each(['stream', 'unary'])('%s credential switch prefers accounts the request already left', async mode => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const error = Object.assign(new Error('upstream unavailable'), { response: { status: 503 }, skipErrorCount: true, shouldSwitchCredential: true });
        const select = selectNext('next-node');
        await run(mode, failing(error), pool(), { switchedFromUuids: ['earlier-node'] });
        expect(select).toHaveBeenCalledTimes(1);
        expect(select.mock.calls[0][2]).toMatchObject({ kiroSession: session });
        expect(select.mock.calls[0][2].preferOtherUuids).toEqual(['earlier-node', 'failed-node']);
    });

    test.each(['stream', 'unary'])('%s same-body retry after an empty response keeps the session binding', async mode => {
        const select = selectNext('failed-node');
        await run(mode, failing(createEmptyUpstreamResponseError('Kiro')), pool(), { switchedFromUuids: ['earlier-node'] });
        expect(select).toHaveBeenCalledTimes(1);
        expect(select.mock.calls[0][2]).toMatchObject({ kiroSession: session, acquireSlot: true });
        // Only accounts the request already left are avoided; the current one stays eligible.
        expect(select.mock.calls[0][2].preferOtherUuids).toEqual(['earlier-node']);
    });

    test.each(['stream', 'unary'])('%s same-body retry after a stall prefers another account', async mode => {
        const stall = Object.assign(kiroIntegrityError('first meaningful event timeout'), { status: 504, preferOtherAccount: true });
        const select = selectNext('next-node');
        await run(mode, failing(stall), pool());
        expect(select).toHaveBeenCalledTimes(1);
        expect(select.mock.calls[0][2]).toMatchObject({ kiroSession: session, preferOtherUuids: ['failed-node'] });
    });

    test.each(['stream', 'unary'])('%s repeat empty response on the bound account prefers another account', async mode => {
        const select = selectNext('next-node');
        await run(mode, failing(createEmptyUpstreamResponseError('Kiro')), pool(), { responseFailureRetry: 1 });
        expect(select).toHaveBeenCalledTimes(1);
        expect(select.mock.calls[0][2]).toMatchObject({ kiroSession: session, preferOtherUuids: ['failed-node'] });
    });

    test.each(['stream', 'unary'])('%s in-stream ValidationException is returned without any retry', async mode => {
        const select = jest.spyOn(services, 'getApiServiceWithFallback');
        const manager = pool();
        const res = await run(mode, failing(streamException('ValidationException')), manager);
        expect(select).not.toHaveBeenCalled();
        assertNoProviderPenalty(manager);
        if (mode === 'unary') expect(res.writeHead.mock.calls[0][0]).toBe(400);
        else expect(res.write.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('"invalid_request_error"');
    });

    test.each(['stream', 'unary'])('%s in-stream ThrottlingException switches credential instead of a same-body retry', async mode => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const select = selectNext('next-node');
        await run(mode, failing(streamException('ThrottlingException')), pool());
        expect(select).toHaveBeenCalledTimes(1);
        expect(select.mock.calls[0][2].preferOtherUuids).toEqual(['failed-node']);
    });

    test.each(['stream', 'unary'])('%s in-stream capacity throttle is returned without penalty or switch, as on the HTTP path', async mode => {
        const select = jest.spyOn(services, 'getApiServiceWithFallback');
        const manager = pool();
        const res = await run(mode, failing(streamException('ThrottlingException', 'INSUFFICIENT_MODEL_CAPACITY')), manager,
            { CONFIG: { SSE_HEARTBEAT_INTERVAL_MS: 0, RATE_LIMIT_COOLDOWN_ENABLED: true } });
        expect(select).not.toHaveBeenCalled();
        assertNoProviderPenalty(manager);
        if (mode === 'unary') expect(res.writeHead.mock.calls[0][0]).toBe(429);
        else expect(res.write.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('"rate_limit_error"');
    });

    test.each(['stream', 'unary'])('%s in-stream account throttle cools the account down and switches', async mode => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const select = selectNext('next-node');
        const manager = pool();
        await run(mode, failing(streamException('ThrottlingException', 'USER_REQUEST_RATE_EXCEEDED')), manager);
        expect(manager.markProviderUnhealthyWithRecoveryTime).toHaveBeenCalledWith(KIRO, { uuid: 'failed-node' }, expect.any(String), expect.any(Date));
        expect(select).toHaveBeenCalledTimes(1);
        expect(select.mock.calls[0][2].preferOtherUuids).toEqual(['failed-node']);
    });
});

describe('in-stream throttle reasons share the HTTP classification', () => {
    const classify = reason => applyKiroStreamExceptionPolicy(kiroIntegrityError('upstream exception'), 'ThrottlingException', reason);
    test('an account rate limit is account-scoped with the short switch jitter', () => {
        expect(classify('USER_REQUEST_RATE_EXCEEDED')).toMatchObject({ status: 429, shouldSwitchCredential: true,
            kiroAccountRateLimited: true, kiroAccountScoped: true, kiroErrorKind: 'account_throttled', isRetryableUpstreamResponseFailure: false });
    });
    test('a service-wide rate limit keeps the full switch wait', () => {
        expect(classify('SERVICE_REQUEST_RATE_EXCEEDED')).toMatchObject({ kiroAccountRateLimited: true, kiroAccountScoped: false });
    });
    test('a reasonless throttle stays an unclassified 429', () => {
        const error = classify('');
        expect(error).toMatchObject({ status: 429, shouldSwitchCredential: true, kiroErrorKind: 'throttled' });
        expect(error.kiroAccountRateLimited).toBeUndefined();
    });
});
