import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import logger from '../src/utils/logger.js';
import { getKiroRemainingCredits, KIRO_CREDIT_EPSILON } from '../src/providers/claude/kiro-usage-credits.js';
import { formatKiroUsage } from '../src/services/usage-service.js';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { KiroApiServiceAdapter } from '../src/providers/adapter.js';
import { handleStreamRequest } from '../src/utils/common.js';

const MODEL = 'claude-opus-5-5';
const NOW = Date.UTC(2026, 10, 4);
const DAY_S = 24 * 60 * 60;
const nowS = NOW / 1000;

// 截图里的账号：基础 909/909 用完，一年期试用 191/500。
function usageWithTrial({ trialStatus = 'ACTIVE', trialExpiry = nowS + 364 * DAY_S, trialUsed = 191 } = {}) {
    return {
        usageBreakdownList: [{
            resourceType: 'CREDIT',
            displayName: 'Credits',
            currentUsageWithPrecision: 909,
            usageLimitWithPrecision: 909,
            nextDateReset: nowS + 27 * DAY_S,
            freeTrialInfo: {
                currentUsageWithPrecision: trialUsed,
                usageLimitWithPrecision: 500,
                freeTrialStatus: trialStatus,
                freeTrialExpiry: trialExpiry
            }
        }]
    };
}

describe('getKiroRemainingCredits', () => {
    test('counts an active trial after the base allowance is used up', () => {
        expect(getKiroRemainingCredits(usageWithTrial(), NOW)).toBeCloseTo(309);
    });

    test.each([499.99, '499.99'])('preserves exactly one cent remaining with usage %s', trialUsed => {
        expect(getKiroRemainingCredits(usageWithTrial({ trialUsed }), NOW)).toBe(KIRO_CREDIT_EPSILON);
    });

    test('keeps genuine sub-cent balances below the usable-credit threshold', () => {
        const remaining = getKiroRemainingCredits(usageWithTrial({ trialUsed: 499.991 }), NOW);
        expect(remaining).toBe(0.009);
        expect(remaining).toBeLessThan(KIRO_CREDIT_EPSILON);
    });

    test('normalizes summed balances without rounding individual sub-cent grants up', () => {
        const usage = usageWithTrial({ trialUsed: 500 });
        usage.usageBreakdownList[0].bonuses = [0.003, 0.006, 0.001].map(usageLimit => ({
            currentUsage: 0, usageLimit, status: 'ACTIVE'
        }));
        expect(getKiroRemainingCredits(usage, NOW)).toBe(KIRO_CREDIT_EPSILON);
        usage.usageBreakdownList[0].bonuses.pop();
        expect(getKiroRemainingCredits(usage, NOW)).toBe(0.009);
    });

    test('ignores a trial marked EXPIRED or past its expiry', () => {
        expect(getKiroRemainingCredits(usageWithTrial({ trialStatus: 'EXPIRED' }), NOW)).toBe(0);
        expect(getKiroRemainingCredits(usageWithTrial({ trialExpiry: nowS - DAY_S }), NOW)).toBe(0);
    });

    test('sums active bonuses and skips expired ones', () => {
        const usage = usageWithTrial({ trialUsed: 500 });
        usage.usageBreakdownList[0].bonuses = [
            { currentUsage: 10, usageLimit: 50, status: 'ACTIVE', expiresAt: nowS + 30 * DAY_S },
            { currentUsage: 0, usageLimit: 100, status: 'EXPIRED', expiresAt: nowS + 30 * DAY_S }
        ];
        expect(getKiroRemainingCredits(usage, NOW)).toBeCloseTo(40);
    });

    test('returns null when the response has no usage breakdown', () => {
        expect(getKiroRemainingCredits({}, NOW)).toBeNull();
        expect(getKiroRemainingCredits(null, NOW)).toBeNull();
    });
});

describe('formatKiroUsage totals', () => {
    beforeEach(() => jest.useFakeTimers({ now: NOW }));
    afterEach(() => jest.useRealTimers());

    test('includes a trial that expires more than three months from now', () => {
        const { summary, items } = formatKiroUsage(usageWithTrial());
        expect(items.map(item => item.id)).toEqual(['CREDIT', 'freetrial_CREDIT']);
        expect(summary.totalUsed).toBeCloseTo(1100);
        expect(summary.totalLimit).toBeCloseTo(1409);
    });

    test('still hides grants that expired more than three months ago', () => {
        const { summary, items } = formatKiroUsage(usageWithTrial({ trialExpiry: nowS - 120 * DAY_S }));
        expect(items.map(item => item.id)).toEqual(['CREDIT']);
        expect(summary.totalLimit).toBeCloseTo(909);
    });
});

function createService(usageLimits) {
    const service = Object.create(KiroApiService.prototype);
    Object.assign(service, {
        config: { REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 1 },
        isInitialized: true,
        accessToken: 'mock-token',
        baseUrl: 'https://mock.invalid/generateAssistantResponse',
        _applySidecar: jest.fn(),
        _prepareAccessTokenForRequest: jest.fn(async () => {}),
        buildCodewhispererRequest: jest.fn(async () => ({})),
        estimateInputTokens: jest.fn(() => 1),
        countTextTokens: jest.fn(text => text.length),
        _requestWithBuilderEndpointRouting: jest.fn(),
        _markCredentialUnhealthyWithRecovery: jest.fn(),
        getUsageLimits: jest.fn(async () => usageLimits)
    });
    service._requestWithBuilderEndpointRouting.mockRejectedValue(Object.assign(new Error('HTTP 402'), {
        response: { status: 402, data: Readable.from(['{"message":"quota exceeded"}']) }
    }));
    return service;
}

const request = () => ({ messages: [{ role: 'user', content: 'hello' }] });

describe('Kiro 402 handling with remaining trial credits', () => {
    beforeEach(() => jest.clearAllMocks());

    test('switches credential for the request without locking the account', async () => {
        const service = createService(usageWithTrial());
        const error = await service.streamApiReal('', MODEL, request(), false, 0, {}).next().catch(e => e);
        expect(error.response.status).toBe(402);
        expect(error.shouldSwitchCredential).toBe(true);
        expect(error.quotaExhausted).toBe(true);
        expect(error.credentialMarkedUnhealthy).toBeUndefined();
        expect(service._markCredentialUnhealthyWithRecovery).not.toHaveBeenCalled();
    });

    test('does not lock an account with exactly one cent remaining', async () => {
        const service = createService(usageWithTrial({ trialUsed: 499.99 }));
        const error = await service.streamApiReal('', MODEL, request(), false, 0, {}).next().catch(e => e);
        expect(error.shouldSwitchCredential).toBe(true);
        expect(error.quotaExhausted).toBe(true);
        expect(service._markCredentialUnhealthyWithRecovery).not.toHaveBeenCalled();
    });

    test('still locks an account whose actual remaining balance is below one cent', async () => {
        const service = createService(usageWithTrial({ trialUsed: 499.991 }));
        const error = await service.streamApiReal('', MODEL, request(), false, 0, {}).next().catch(e => e);
        expect(error.shouldSwitchCredential).toBe(true);
        expect(error.quotaExhausted).toBeUndefined();
        expect(service._markCredentialUnhealthyWithRecovery).toHaveBeenCalledTimes(1);
    });

    test('still locks the account until next month when every allowance is used up', async () => {
        const service = createService(usageWithTrial({ trialUsed: 500 }));
        const error = await service.streamApiReal('', MODEL, request(), false, 0, {}).next().catch(e => e);
        expect(error.shouldSwitchCredential).toBe(true);
        expect(error.quotaExhausted).toBeUndefined();
        expect(service._markCredentialUnhealthyWithRecovery).toHaveBeenCalledTimes(1);
        const [, , recoveryTime] = service._markCredentialUnhealthyWithRecovery.mock.calls[0];
        expect(recoveryTime.getUTCDate()).toBe(1);
    });

    test('a single-account pool returns the 402 without marking the account unhealthy', async () => {
        const service = createService(usageWithTrial());
        const adapter = Object.create(KiroApiServiceAdapter.prototype);
        adapter.kiroApiService = service;
        const response = new EventEmitter();
        Object.assign(response, {
            writableEnded: false,
            writeHead: jest.fn(),
            flushHeaders: jest.fn(),
            write: jest.fn(() => true),
            end: jest.fn(() => { response.writableEnded = true; })
        });
        const pool = {
            releaseSlot: jest.fn(),
            markProviderHealthy: jest.fn(),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            selectProviderWithFallback: jest.fn(async () => null)
        };

        await handleStreamRequest(
            response, adapter, MODEL, request(), 'claude', 'claude-kiro-oauth',
            'none', null, pool, 'test-account', null, { CONFIG: {}, maxRetries: 3 }
        );

        expect(pool.selectProviderWithFallback).toHaveBeenCalledWith('claude-kiro-oauth', MODEL,
            expect.objectContaining({ excludeUuids: ['test-account'] }));
        expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(pool.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(service._markCredentialUnhealthyWithRecovery).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('no alternate credential exists'));
        expect(response.end).toHaveBeenCalled();
    });
});
