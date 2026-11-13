import { EventEmitter, getEventListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
import { getRequestBody } from '../src/utils/common.js';
import logger from '../src/utils/logger.js';

const incoming = () => Object.assign(new EventEmitter(), { headers: {}, destroy: jest.fn(), resume: jest.fn() });
afterEach(() => jest.restoreAllMocks());

test('records upload and parse stages outside the parsed request without logging content', async () => {
    const times = [10, 30, 70, 72, 73, 78];
    jest.spyOn(performance, 'now').mockImplementation(() => times.shift());
    const req = incoming(), timing = {}, controller = new AbortController();
    const body = { messages: [{ role: 'user', content: 'private 中文 🟢' }] };
    const bytes = Buffer.from(JSON.stringify(body));
    const pending = getRequestBody(req, { timing, signal: controller.signal });
    // Split a multibyte sequence; timing collection must preserve decoding semantics.
    for (let i = 0; i < bytes.length; i++) req.emit('data', bytes.subarray(i, i + 1));
    req.emit('end');
    await expect(pending).resolves.toEqual(body);
    expect(timing).toEqual({ bytes: bytes.length, chunks: bytes.length, firstDataMs: 20, endMs: 60, concatDecodeMs: 2, jsonParseMs: 5 });
    expect(req).not.toHaveProperty('bodyTiming');
    expect(logger.info).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(req.listenerCount('aborted')).toBe(0);
});

test('empty bodies keep their original return value and have no first data or parse time', async () => {
    const req = incoming(), timing = {};
    const pending = getRequestBody(req, { timing }); req.emit('end');
    await expect(pending).resolves.toEqual({});
    expect(timing).toMatchObject({ bytes: 0, chunks: 0, firstDataMs: null, jsonParseMs: 0 });
    expect(timing.endMs).toBeGreaterThanOrEqual(0);
});

test('invalid JSON still rejects and records parse duration', async () => {
    const req = incoming(), timing = {}, controller = new AbortController();
    const pending = getRequestBody(req, { timing, signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow('Invalid JSON in request body.');
    req.emit('data', Buffer.from('{broken')); req.emit('end'); await rejection;
    expect(timing.jsonParseMs).toBeGreaterThanOrEqual(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

test('string chunks count UTF-8 bytes for timing and the body budget', async () => {
    const body = '{"text":"中文🟢"}';
    const bytes = Buffer.byteLength(body);
    const req = incoming(), timing = {};
    const pending = getRequestBody(req, { maxBytes: bytes, timing });
    req.emit('data', body); req.emit('end');
    await expect(pending).resolves.toEqual({ text: '中文🟢' });
    expect(timing.bytes).toBe(bytes);
    const oversized = incoming();
    const rejected = getRequestBody(oversized, { maxBytes: bytes - 1 });
    const assertion = expect(rejected).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    oversized.emit('data', body); await assertion;
    expect(oversized.resume).toHaveBeenCalledTimes(1);
});

test.each([true, false])('size rejection preserves drain behavior (Content-Length: %s)', async contentLength => {
    const req = incoming(), controller = new AbortController(), timing = {};
    if (contentLength) req.headers['content-length'] = '100';
    const pending = getRequestBody(req, { maxBytes: 5, timing, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ statusCode: 413, code: 'BODY_TOO_LARGE' });
    if (!contentLength) req.emit('data', Buffer.from('too large'));
    await rejection;
    expect(req.resume).toHaveBeenCalledTimes(1);
    expect(req.destroy).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

test.each(['signal', 'request', 'error', 'preaborted'])('body reading settles and removes cancellation listeners on %s', async kind => {
    const req = incoming(), controller = new AbortController(), timing = {};
    const reason = new Error('client stopped');
    if (kind === 'preaborted') controller.abort(reason);
    const pending = getRequestBody(req, { timing, signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow(kind === 'request' ? 'Request body aborted' : 'client stopped');
    if (kind !== 'preaborted') req.emit('data', Buffer.from('{"partial":'));
    if (kind === 'signal') controller.abort(reason);
    if (kind === 'request') req.emit('aborted');
    if (kind === 'error') req.emit('error', reason);
    await rejection;
    expect(req.destroy).toHaveBeenCalledTimes(1);
    expect(timing.endMs).toBeNull();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(req.listenerCount('aborted')).toBe(0);
    req.emit('end');
});
