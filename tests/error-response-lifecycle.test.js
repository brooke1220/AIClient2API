import { getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import { getNormalizedErrorResponseText, normalizeProviderErrorMessage } from '../src/utils/common.js';

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const openStream = options => new Readable({ read() {}, ...options });
const errorWith = data => Object.assign(new Error('original upstream failure'), { response: { status: 503, data } });

async function bounded(operation, ms = 500) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Error reader did not settle')), ms); })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

describe('bounded error-response body reading', () => {
    test.each([
        [{ error: { message: 'nested failure' } }, 'nested failure'],
        ['plain upstream failure', 'plain upstream failure'],
        [null, 'original upstream failure']
    ])('preserves the non-stream response format for %p', async (data, expected) => {
        await expect(getNormalizedErrorResponseText(errorWith(data))).resolves.toBe(expected);
    });

    test('normalizes streamed JSON including UTF-8 split across chunks', async () => {
        const body = Buffer.from('{"message":"上游错误"}');
        const data = Readable.from([body.subarray(0, 14), body.subarray(14, 17), body.subarray(17)]);
        await expect(getNormalizedErrorResponseText(errorWith(data))).resolves.toBe('上游错误');
    });

    test('limits an oversized chunk to the requested byte budget and closes the body', async () => {
        const data = openStream();
        data.push(Buffer.from('abcdef'.repeat(10000)));
        await expect(bounded(getNormalizedErrorResponseText(errorWith(data), { maxBytes: 8 }))).resolves.toBe('abcdefab');
        expect(data.destroyed).toBe(true);
    });

    test('the default byte budget limits unknown-size error responses', async () => {
        const data = openStream();
        data.push(Buffer.alloc(128 * 1024, 'x'));
        const text = await bounded(getNormalizedErrorResponseText(errorWith(data)));
        expect(Buffer.byteLength(text)).toBe(64 * 1024);
        expect(data.destroyed).toBe(true);
    });

    test.each([{}, { emitClose: false }])('a read deadline closes a silent stream with options %p', async options => {
        const data = openStream(options);
        try {
            await expect(bounded(getNormalizedErrorResponseText(errorWith(data), { timeoutMs: 15 }))).resolves.toBe('original upstream failure');
            expect(data.destroyed).toBe(true);
        } finally {
            data.destroy();
        }
    });

    test('normalization forwards the deadline instead of hanging in an error read', async () => {
        const data = openStream();
        const error = errorWith(data);
        try {
            await expect(bounded(normalizeProviderErrorMessage(error, { context: 'stream', timeoutMs: 15 }))).resolves.toMatchObject({
                status: 503, responseText: 'original upstream failure', reason: '503 Service Unavailable (stream): original upstream failure'
            });
        } finally {
            data.destroy();
        }
    });

    test('abort after partial data rejects with the original reason without overwriting the HTTP error', async () => {
        const data = openStream();
        const error = errorWith(data);
        const controller = new AbortController();
        const reason = new Error('client disconnected');
        const pending = normalizeProviderErrorMessage(error, { signal: controller.signal, timeoutMs: 10000 });
        const rejection = expect(bounded(pending)).rejects.toBe(reason);
        try {
            data.push('{"message":"partial');
            await nextTurn();
            controller.abort(reason);
            await rejection;
            expect(data.destroyed).toBe(true);
            expect(error.message).toBe('original upstream failure');
            expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        } finally {
            data.destroy();
        }
    });

    test('a pre-aborted read destroys its body and does not add abort listeners', async () => {
        const data = openStream();
        const controller = new AbortController();
        controller.abort();
        await expect(getNormalizedErrorResponseText(errorWith(data), { signal: controller.signal })).rejects.toBe(controller.signal.reason);
        expect(data.destroyed).toBe(true);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    test('abort while a buffered body is being normalized cannot overwrite the HTTP error', async () => {
        const controller = new AbortController();
        const error = errorWith({ message: 'buffered upstream body' });
        const pending = normalizeProviderErrorMessage(error, { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toBe(controller.signal.reason);
        expect(error.message).toBe('original upstream failure');
    });

    test('successful reads remove their cancellation listeners', async () => {
        const controller = new AbortController();
        const data = Readable.from(['{"message":"upstream failure"}']);
        await expect(getNormalizedErrorResponseText(errorWith(data), { signal: controller.signal })).resolves.toBe('upstream failure');
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });
});
