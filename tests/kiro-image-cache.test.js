import { jest } from '@jest/globals';
import { getEventListeners } from 'node:events';
import sharp from 'sharp';
import { KiroImageCache, kiroImageCache, normalizeKiroImages } from '../src/providers/claude/kiro-images.js';

const picture = bytes => ({ format: 'png', source: { bytes: bytes.toString('base64') } });
const payload = image => ({ conversationState: { history: [{ userInputMessage: { images: [image] } }] } });
const result = bytes => ({ format: 'png', bytes });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
let png;

beforeAll(async () => {
    png = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#765432' } }).png().toBuffer();
});
beforeEach(() => kiroImageCache.clear());
afterEach(() => { kiroImageCache.clear(); jest.restoreAllMocks(); });

test('repeated history reuses validated output without sharing mutable image objects', async () => {
    const decode = jest.spyOn(sharp.prototype, 'stats');
    const first = payload(picture(png)), second = payload(picture(png));
    await normalizeKiroImages(first);
    await normalizeKiroImages(second);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    first.conversationState.history[0].userInputMessage.images[0].source.bytes = 'changed';
    expect(second.conversationState.history[0].userInputMessage.images[0].source.bytes).toBe(png.toString('base64'));
});

test.each([
    ['KIRO_IMAGE_MAX_SOURCE_BYTES', 1000000],
    ['KIRO_IMAGE_MAX_PIXELS', 1000],
    ['KIRO_IMAGE_MAX_EDGE', 100],
    ['KIRO_IMAGE_MAX_BASE64_BYTES', 100000]
])('all normalization limits isolate successful cache entries: %s', async (name, value) => {
    const decode = jest.spyOn(sharp.prototype, 'stats');
    await normalizeKiroImages(payload(picture(png)));
    await normalizeKiroImages(payload(picture(png)), { [name]: value });
    expect(decode).toHaveBeenCalledTimes(2);
});

test('a warm image cannot bypass stricter source or pixel limits', async () => {
    await normalizeKiroImages(payload(picture(png)));
    await expect(normalizeKiroImages(payload(picture(png)), { KIRO_IMAGE_MAX_SOURCE_BYTES: 10 }))
        .rejects.toMatchObject({ status: 413 });
    await expect(normalizeKiroImages(payload(picture(png)), { KIRO_IMAGE_MAX_PIXELS: 10 }))
        .rejects.toMatchObject({ code: 'KIRO_IMAGE_INVALID' });
});

test('corrupt image failures are never cached', async () => {
    const decode = jest.spyOn(sharp.prototype, 'metadata');
    const corrupt = png.subarray(0, png.length - 30);
    for (let i = 0; i < 2; i++) await expect(normalizeKiroImages(payload(picture(corrupt))))
        .rejects.toMatchObject({ code: 'KIRO_IMAGE_INVALID' });
    expect(decode).toHaveBeenCalledTimes(2);
    expect(kiroImageCache.entries.size).toBe(0);
});

test('concurrent same-content requests share one successful normalization', async () => {
    const cache = new KiroImageCache();
    const pending = gate();
    const loader = jest.fn(() => pending.promise);
    const first = cache.get('same', loader), second = cache.get('same', loader);
    await tick();
    expect(loader).toHaveBeenCalledTimes(1);
    pending.resolve(result('validated'));
    await expect(first).resolves.toEqual(result('validated'));
    await expect(second).resolves.toEqual(result('validated'));
    expect(cache.inflight.size).toBe(0);
    await cache.get('same', loader);
    expect(loader).toHaveBeenCalledTimes(1);
});

test('cancelling one waiter does not cancel another, and all-cancelled work cannot warm the cache', async () => {
    const cache = new KiroImageCache();
    const pending = gate(), controller = new AbortController();
    const loader = jest.fn(() => pending.promise);
    const first = cache.get('shared', loader, controller.signal);
    const rejection = expect(first).rejects.toThrow(/abort/i);
    const second = cache.get('shared', loader);
    controller.abort(); await rejection;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    pending.resolve(result('shared')); await second;
    expect(cache.entries.has('shared')).toBe(true);

    const alone = gate(), abandoned = new AbortController();
    const only = cache.get('abandoned', () => alone.promise, abandoned.signal);
    const cancelled = expect(only).rejects.toThrow(/abort/i);
    await tick(); abandoned.abort(); await cancelled;
    expect(getEventListeners(abandoned.signal, 'abort')).toHaveLength(0);
    alone.resolve(result('unused')); await tick();
    expect(cache.entries.has('abandoned')).toBe(false);
    expect(cache.inflight.size).toBe(0);
});

test('cancellation while decoding leaves the image unchanged and does not cache success', async () => {
    const pending = gate(), entered = gate(), controller = new AbortController();
    jest.spyOn(sharp.prototype, 'stats').mockImplementationOnce(() => { entered.resolve(); return pending.promise; });
    const data = payload(picture(png));
    const operation = normalizeKiroImages(data, {}, controller.signal);
    const rejection = expect(operation).rejects.toThrow(/abort/i);
    await entered.promise; controller.abort(); await rejection;
    pending.resolve({}); await tick();
    expect(data).toEqual(payload(picture(png)));
    expect(kiroImageCache.entries.size).toBe(0);
});

test('aborting after producer completion but before delivery does not cache an abandoned result', async () => {
    const cache = new KiroImageCache(), pending = gate(), controller = new AbortController();
    const operation = cache.get('race', () => pending.promise, controller.signal);
    const rejection = expect(operation).rejects.toThrow(/abort/i);
    await tick(); pending.resolve(result('validated'));
    queueMicrotask(() => controller.abort());
    await rejection; await tick();
    expect(cache.entries.size).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

test('TTL releases retained output even when no more requests arrive', async () => {
    const cache = new KiroImageCache({ ttlMs: 5 });
    await cache.get('idle', async () => result('validated'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(cache.entries.size).toBe(0);
    expect(cache.bytes).toBe(0);
});

test('expiry, entry and byte budgets evict output, and oversized results are not retained', async () => {
    let now = 0;
    const cache = new KiroImageCache({ maxEntries: 2, maxBytes: 30, ttlMs: 10, now: () => now });
    const loader = jest.fn(async () => result('123456'));
    await cache.get('a', loader); await cache.get('b', loader); await cache.get('a', loader); await cache.get('c', loader);
    expect([...cache.entries.keys()]).toEqual(['a', 'c']);
    expect(cache.bytes).toBeLessThanOrEqual(30);
    await cache.get('large', async () => result('x'.repeat(100)));
    expect(cache.entries.has('large')).toBe(false);
    now = 11; await cache.get('a', loader);
    expect(loader).toHaveBeenCalledTimes(4);
    expect([...cache.entries.keys()]).toEqual(['a']);
    const bytes = new KiroImageCache({ maxEntries: 10, maxBytes: 15 });
    await bytes.get('a', loader); await bytes.get('b', loader);
    expect(bytes.entries.size).toBe(1);
    expect(bytes.bytes).toBeLessThanOrEqual(15);
});

test('coalescing state remains bounded when distinct requests exceed its capacity', async () => {
    const cache = new KiroImageCache({ maxInflight: 1 });
    const pending = gate();
    const first = cache.get('first', () => pending.promise);
    const second = cache.get('second', () => pending.promise);
    expect(cache.inflight.size).toBe(1);
    pending.resolve(result('ok')); await Promise.all([first, second]);
    expect(cache.inflight.size).toBe(0);
});
