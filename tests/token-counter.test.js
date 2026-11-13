import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { warn: jest.fn() } }));
import { TokenCounter, countTextsTokensAsync, estimateInputTokensAsync, disposeTokenCounter } from '../src/utils/token-counter.js';
import { countTextTokens, estimateInputTokens, disposeTokenizer } from '../src/utils/token-utils.js';
import logger from '../src/utils/logger.js';

const fakeWorker = () => Object.assign(new EventEmitter(), {
    ref: jest.fn(), unref: jest.fn(), postMessage: jest.fn(), terminate: jest.fn(async () => 0)
});
const reply = (worker, count) => worker.emit('message', { id: worker.postMessage.mock.calls.at(-1)[0].id, count });

afterAll(async () => { await disposeTokenCounter(); disposeTokenizer(); });

test('background counts preserve normalization, media estimates, thinking and independent tool boundaries', async () => {
    const input = {
        system: [{ type: 'text', text: 'ﬃ 中文\u0000' }], thinking: { type: 'enabled', budget_tokens: 2048 },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello 😀 e\u0301' },
            { type: 'image', source: { type: 'base64', data: 'YWJj' } },
            { type: 'tool_result', content: [{ type: 'text', text: '工具结果' }] }] }],
        tools: [{ name: 'read', input_schema: { type: 'object' } }]
    };
    expect(await estimateInputTokensAsync(input)).toBe(estimateInputTokens(input));
    const texts = [' hello\n世界', JSON.stringify({ text: '🟢'.repeat(50) }), '', '<|endoftext|>', '\ud800'];
    expect(await countTextsTokensAsync(texts)).toBe(texts.reduce((sum, text) => sum + countTextTokens(text), 0));
});

test('large text encoding yields the main event loop while the worker counts', async () => {
    await countTextsTokensAsync(['warmup']);
    const large = 'const result = 中文处理(input);\n'.repeat(30000);
    let finished = false;
    const operation = countTextsTokensAsync([large]).then(count => { finished = true; return count; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    expect(await operation).toBe(countTextTokens(large));
});

test('active and queued task count and character budgets are bounded', async () => {
    const worker = fakeWorker(), counter = new TokenCounter({ createWorker: () => worker, maxTasks: 2, maxChars: 8 });
    try {
        const first = counter.count(['1234']), second = counter.count(['1234']);
        await expect(counter.count(['x'])).rejects.toMatchObject({ code: 'TOKEN_COUNTER_UNAVAILABLE' });
        expect(counter.chars).toBe(8);
        expect(worker.postMessage).toHaveBeenCalledTimes(1);
        reply(worker, 2); expect(await first).toBe(2);
        expect(worker.postMessage).toHaveBeenCalledTimes(2);
        reply(worker, 3); expect(await second).toBe(3);
        expect(counter.chars).toBe(0);
        expect(counter.queue).toHaveLength(0);
        await expect(counter.count(['123456789'])).rejects.toMatchObject({ code: 'TOKEN_COUNTER_UNAVAILABLE' });
    } finally { await counter.dispose(); }
});

test('a queued cancellation drops its text and preserves unrelated work', async () => {
    const worker = fakeWorker(), counter = new TokenCounter({ createWorker: () => worker });
    try {
        const active = counter.count(['active']);
        const controller = new AbortController();
        const pending = counter.count(['queued'], { signal: controller.signal });
        const rejected = expect(pending).rejects.toThrow('cancel this request');
        controller.abort(new Error('cancel this request'));
        await rejected;
        expect(counter.chars).toBe(6);
        expect(counter.queue).toHaveLength(0);
        expect(worker.terminate).not.toHaveBeenCalled();
        reply(worker, 1); await active;
        expect(counter.chars).toBe(0);
    } finally { await counter.dispose(); }
});

test('an active cancellation terminates its CPU job and restarts the worker for the queued request', async () => {
    const workers = [fakeWorker(), fakeWorker()];
    const counter = new TokenCounter({ createWorker: jest.fn().mockReturnValueOnce(workers[0]).mockReturnValueOnce(workers[1]) });
    try {
        const controller = new AbortController();
        const first = counter.count(['cancel'], { signal: controller.signal });
        const rejection = expect(first).rejects.toThrow('cancel');
        const second = counter.count(['keep']);
        controller.abort(new Error('cancel'));
        await rejection;
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);
        workers[0].emit('message', { id: 1, count: 1000 });
        workers[0].emit('exit', 1);
        expect(counter.chars).toBe(4);
        reply(workers[1], 2); expect(await second).toBe(2);
        expect(counter.chars).toBe(0);
    } finally { await counter.dispose(); }
});

test('worker failure rejects only the active job and a replacement handles queued work', async () => {
    const workers = [fakeWorker(), fakeWorker()];
    const counter = new TokenCounter({ createWorker: jest.fn().mockReturnValueOnce(workers[0]).mockReturnValueOnce(workers[1]) });
    try {
        const first = counter.count(['first']);
        const rejection = expect(first).rejects.toMatchObject({ code: 'TOKEN_COUNTER_UNAVAILABLE' });
        const second = counter.count(['second']);
        workers[0].emit('error', new Error('worker failed'));
        await rejection;
        reply(workers[1], 3); expect(await second).toBe(3);
        expect(counter.chars).toBe(0);
    } finally { await counter.dispose(); }
});

test('shutdown clears pending text, listeners and deadlines without resurrecting a worker', async () => {
    const worker = fakeWorker(), counter = new TokenCounter({ createWorker: () => worker });
    const controller = new AbortController();
    const first = counter.count(['active'], { signal: controller.signal });
    const second = counter.count(['queued']);
    const failures = Promise.all([expect(first).rejects.toThrow('unavailable'), expect(second).rejects.toThrow('unavailable')]);
    await counter.dispose(); await failures;
    controller.abort(); worker.emit('exit', 0);
    expect(counter.chars).toBe(0);
    expect(counter.active).toBeNull();
    expect(counter.queue).toHaveLength(0);
    await expect(counter.count(['later'])).rejects.toMatchObject({ code: 'TOKEN_COUNTER_UNAVAILABLE' });
});

test('already aborted input and output counts reject instead of reporting a successful approximation', async () => {
    const controller = new AbortController(); controller.abort(new Error('client disconnected'));
    await expect(countTextsTokensAsync(['hello'], { signal: controller.signal })).rejects.toThrow('client disconnected');
    await expect(estimateInputTokensAsync({ messages: [] }, { signal: controller.signal })).rejects.toThrow('client disconnected');
});

test('a timed-out worker is terminated and queued work moves to a replacement', async () => {
    const workers = [fakeWorker(), fakeWorker()];
    const counter = new TokenCounter({ timeoutMs: 10,
        createWorker: jest.fn().mockReturnValueOnce(workers[0]).mockReturnValueOnce(workers[1]) });
    try {
        const first = counter.count(['slow']);
        const failure = expect(first).rejects.toMatchObject({ code: 'TOKEN_COUNTER_UNAVAILABLE' });
        const second = counter.count(['next']);
        await failure;
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);
        reply(workers[1], 3);
        expect(await second).toBe(3);
        expect(counter.chars).toBe(0);
    } finally { await counter.dispose(); }
});

test('over-budget public counting uses the existing approximation without blocking on an encoder', async () => {
    const large = 'x'.repeat(32 * 1024 * 1024 + 1);
    expect(await countTextsTokensAsync([large])).toBe(Math.ceil(large.length / 4));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('using local length estimate'));
});
