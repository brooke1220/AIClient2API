import { Readable } from 'node:stream';
import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import { collect, frame, model, request, service, text, tick, bounded } from './helpers/kiro-safety-fixtures.js';

const native = frame('metadataEvent', { tokenUsage: {
    uncachedInputTokens: 41, outputTokens: 9, cacheReadInputTokens: 11, cacheWriteInputTokens: 3
} });
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

test('estimate mode skips both local encoders when complete provider usage is available', async () => {
    const backend = service([text('answer'), native], { KIRO_PROMPT_CACHE_MODE: 'estimate' });
    backend.estimateInputTokensAsync = jest.fn(() => { throw new Error('unexpected input estimate'); });
    backend.countTextsTokensAsync = jest.fn(() => { throw new Error('unexpected output estimate'); });
    const events = await collect(backend.generateContentStream(model, request()));
    expect(events[0].message.usage.input_tokens).toBe(0);
    expect(events.find(event => event.type === 'message_delta').usage).toEqual({
        input_tokens: 41, output_tokens: 9, cache_read_input_tokens: 11, cache_creation_input_tokens: 3
    });
    expect(backend.estimateInputTokensAsync).not.toHaveBeenCalled();
    expect(backend.countTextsTokensAsync).not.toHaveBeenCalled();
});

test('ordinary accounting starts after dispatch and before headers, preserving initial input usage', async () => {
    const backend = service();
    const headers = deferred(), count = deferred(), order = [];
    backend._requestWithBuilderEndpointRouting.mockImplementation(() => {
        order.push('dispatch'); return headers.promise;
    });
    backend.estimateInputTokensAsync = jest.fn(() => { order.push('count'); return count.promise; });
    const iterator = backend.generateContentStream(model, request());
    const first = iterator.next();
    try {
        await tick();
        expect(order).toEqual(['dispatch', 'count']);
        count.resolve(87);
        headers.resolve({ data: Readable.from([text('answer'), native]) });
        expect((await bounded(first)).value.message.usage.input_tokens).toBe(87);
        const remaining = await collect(iterator);
        expect(remaining.find(event => event.type === 'message_delta').usage.input_tokens).toBe(41);
        expect(backend.estimateInputTokensAsync).toHaveBeenCalledTimes(1);
    } finally {
        count.resolve(87); headers.resolve({ data: Readable.from([]) });
        await iterator.return();
    }
});

test.each(['off', 'observe'])('metadata preceding content does not spend the first-event deadline waiting on %s accounting', async mode => {
    const backend = service([], { KIRO_PROMPT_CACHE_MODE: mode, KIRO_FIRST_EVENT_TIMEOUT_MS: 20 });
    const upstream = Readable.from([frame('contextUsageEvent', { contextUsagePercentage: 1 }), native, text('answer')]);
    const count = deferred(), started = deferred();
    backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
    backend.estimateInputTokensAsync = jest.fn(() => { started.resolve(); return count.promise; });
    const operation = collect(backend.generateContentStream(model, request()));
    try {
        await bounded(started.promise);
        await tick();
        // Accounting can wait longer than the upstream deadline after content
        // arrived; its estimate still belongs in the initial usage event.
        await new Promise(resolve => setTimeout(resolve, 40));
        count.resolve(87);
        const events = await bounded(operation);
        expect(events[0].message.usage.input_tokens).toBe(87);
        expect(events.some(event => event.delta?.text === 'answer')).toBe(true);
        expect(events.find(event => event.type === 'message_delta').usage.input_tokens).toBe(41);
        expect(backend.estimateInputTokensAsync).toHaveBeenCalledTimes(1);
        expect(backend._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
    } finally {
        count.resolve(87);
        upstream.destroy();
        await operation.catch(() => {});
    }
});

test('metadata-only upstream still times out while background accounting is pending', async () => {
    const backend = service([], { KIRO_FIRST_EVENT_TIMEOUT_MS: 20 });
    const upstream = new Readable({ read() {} }), controller = new AbortController();
    upstream.push(frame('contextUsageEvent', { contextUsagePercentage: 1 }));
    backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
    let countingSignal;
    backend.estimateInputTokensAsync = jest.fn((_, { signal }) => new Promise((resolve, reject) => {
        countingSignal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const operation = collect(backend.generateContentStream(model, request(), { signal: controller.signal }));
    try {
        await expect(bounded(operation)).rejects.toMatchObject({ status: 504, preferOtherAccount: true });
        expect(countingSignal.aborted).toBe(true);
        expect(upstream.destroyed).toBe(true);
        expect(backend._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
    } finally {
        controller.abort();
        upstream.destroy();
        await operation.catch(() => {});
    }
});

test.each([
    [{ signature: 'opaque-signature' }, 'thinking'],
    [{ redactedContent: 'opaque-redacted' }, 'redacted_thinking']
])('reasoning %p precedes delayed initial usage with a message_start event', async (payload, blockType) => {
    const backend = service([frame('reasoningContentEvent', payload), native], { KIRO_FIRST_EVENT_TIMEOUT_MS: 20 });
    const count = deferred(), started = deferred();
    backend.estimateInputTokensAsync = jest.fn(() => { started.resolve(); return count.promise; });
    const operation = collect(backend.generateContentStream(model, request()));
    try {
        await bounded(started.promise);
        await tick();
        await new Promise(resolve => setTimeout(resolve, 40));
        count.resolve(87);
        const events = await bounded(operation);
        expect(events[0]).toMatchObject({ type: 'message_start', message: { usage: { input_tokens: 87 } } });
        expect(events[1]).toMatchObject({ type: 'content_block_start', content_block: { type: blockType } });
        expect(events.at(-1).type).toBe('message_stop');
    } finally {
        count.resolve(87);
        await operation.catch(() => {});
    }
});

test('invalid terminal metadata fails without waiting for pending initial accounting', async () => {
    const backend = service([frame('metadataEvent', { stopReason: 'UNSUPPORTED_REASON' })]);
    const controller = new AbortController();
    let countingSignal;
    backend.estimateInputTokensAsync = jest.fn((_, { signal }) => new Promise((resolve, reject) => {
        countingSignal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const operation = collect(backend.generateContentStream(model, request(), { signal: controller.signal }));
    try {
        await expect(bounded(operation)).rejects.toThrow('unsupported upstream stop reason');
        expect(countingSignal.aborted).toBe(true);
    } finally {
        controller.abort();
        await operation.catch(() => {});
    }
});

test('missing usage counts complete output texts independently and shares one input estimate', async () => {
    const backend = service([text('answer'), frame('toolUseEvent', {
        toolUseId: 'one', name: 'read', input: '{"path":"a"}', stop: true
    })]);
    backend.estimateInputTokensAsync = jest.fn(async () => 87);
    backend.countTextsTokensAsync = jest.fn(async () => 19);
    const events = await collect(backend.generateContentStream(model, request()));
    expect(events[0].message.usage.input_tokens).toBe(87);
    expect(events.find(event => event.type === 'message_delta').usage).toMatchObject({ input_tokens: 87, output_tokens: 19 });
    expect(backend.countTextsTokensAsync).toHaveBeenCalledWith(['answer', '{"path":"a"}'],
        expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(backend.estimateInputTokensAsync).toHaveBeenCalledTimes(1);
});

test('cancellation during initial accounting aborts the count and destroys upstream without replay', async () => {
    const backend = service();
    const upstream = Readable.from([text('answer')]), controller = new AbortController();
    const started = deferred();
    let countingSignal;
    backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
    backend.estimateInputTokensAsync = jest.fn((_, { signal }) => new Promise((resolve, reject) => {
        countingSignal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started.resolve();
    }));
    const operation = collect(backend.generateContentStream(model, request(), { signal: controller.signal }));
    const failure = expect(operation).rejects.toThrow('client disconnected');
    await bounded(started.promise);
    controller.abort(new Error('client disconnected'));
    await bounded(failure);
    expect(countingSignal.aborted).toBe(true);
    expect(upstream.destroyed).toBe(true);
    expect(backend._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
});
