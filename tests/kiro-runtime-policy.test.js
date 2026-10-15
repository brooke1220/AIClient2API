import { EventEmitter, getEventListeners } from 'node:events';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import { getRateLimitCooldownRecoveryTime } from '../src/utils/common.js';
import { writeWithBackpressure } from '../src/utils/stream-lifecycle.js';

const now = Date.UTC(2026, 9, 15);
const KIRO = 'claude-kiro-oauth';
const config = { RATE_LIMIT_COOLDOWN_ENABLED: true, RATE_LIMIT_COOLDOWN_MAX_MS: 300000 };
const limited = value => ({ response: { status: 429, headers: { 'retry-after': value } } });
const seconds = date => (date.getTime() - now) / 1000;

describe('Kiro cooldown respects upstream deadlines without changing other channels', () => {
    afterEach(() => jest.restoreAllMocks());

    test.each([KIRO, `${KIRO}-team`])('%s preserves an explicit hour-long deadline', provider => {
        expect(seconds(getRateLimitCooldownRecoveryTime(limited('3600'), config, now, provider))).toBe(3600);
    });
    test.each(['openai-custom', 'claude-custom', undefined])('%s keeps its existing local ceiling', provider => {
        expect(seconds(getRateLimitCooldownRecoveryTime(limited('3600'), config, now, provider))).toBe(300);
    });
    test('HTTP-date deadlines and positive jitter never recover Kiro early', () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.5);
        const upstreamAt = now + 3600000;
        const result = getRateLimitCooldownRecoveryTime(limited(new Date(upstreamAt).toUTCString()), {
            ...config, RATE_LIMIT_COOLDOWN_JITTER_MS: 1000
        }, now, KIRO);
        expect(result.getTime()).toBeGreaterThanOrEqual(upstreamAt);
        expect(result.getTime()).toBeLessThanOrEqual(upstreamAt + 1000);
    });
    test('missing server deadlines still use the configured local fallback', () => {
        const result = getRateLimitCooldownRecoveryTime(limited('invalid'), {
            ...config, RATE_LIMIT_COOLDOWN_MS: 45000
        }, now, KIRO);
        expect(seconds(result)).toBe(45);
    });
    test('disabled cooldown stays opt-in and local account guards are not upstream throttling', () => {
        expect(getRateLimitCooldownRecoveryTime(limited('3600'), {}, now, KIRO)).toBeNull();
        expect(getRateLimitCooldownRecoveryTime({ ...limited('3600'), isKiroAccountUnavailable: true }, config, now, KIRO)).toBeNull();
    });
    test('an exceptionally long server delay produces a valid far-future Date', () => {
        const result = getRateLimitCooldownRecoveryTime(limited('999999999999999'), config, now, KIRO);
        expect(Number.isFinite(result.getTime())).toBe(true);
        expect(result.getTime()).toBeGreaterThan(now + 3600000);
    });
});

describe('optional downstream write deadlines clean up all resources', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    function stalledResponse() {
        const res = new EventEmitter();
        res.write = jest.fn(() => false);
        return res;
    }

    test('a blocked write rejects at its deadline and removes temporary listeners', async () => {
        const res = stalledResponse();
        const controller = new AbortController();
        const pending = writeWithBackpressure(res, 'data: pending\n\n', controller.signal, () => {}, { timeoutMs: 20 });
        const rejection = expect(pending).rejects.toMatchObject({ code: 'DOWNSTREAM_WRITE_TIMEOUT', isDownstreamWriteError: true });
        await jest.advanceTimersByTimeAsync(20);
        await rejection;
        expect(res.listenerCount('drain')).toBe(0);
        expect(res.listenerCount('close')).toBe(0);
        expect(res.listenerCount('error')).toBe(0);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        expect(jest.getTimerCount()).toBe(0);
    });
    test('a drain before the deadline cancels the timer instead of rejecting later', async () => {
        const res = stalledResponse();
        const pending = writeWithBackpressure(res, 'data: ok\n\n', undefined, () => {}, { timeoutMs: 20 });
        res.emit('drain');
        await pending;
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(30);
    });
    test('callers without a deadline retain their existing drain behavior', async () => {
        const res = stalledResponse();
        let completed = false;
        const pending = writeWithBackpressure(res, 'data: legacy\n\n').then(() => { completed = true; });
        await jest.advanceTimersByTimeAsync(60000);
        expect(completed).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
        res.emit('drain');
        await pending;
    });
});
