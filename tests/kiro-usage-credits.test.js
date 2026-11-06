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
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

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
        expect(error.kiroModelRejected).toBe(true);
        expect(error.credentialMarkedUnhealthy).toBeUndefined();
        expect(service._markCredentialUnhealthyWithRecovery).not.toHaveBeenCalled();
    });

    test.each([['credits remain', usageWithTrial(), 'warn'], ['quota exhausted', usageWithTrial({ trialUsed: 500 }), 'info']])(
        'logs the upstream 402 reason when %s', async (_, usage, level) => {
            const service = createService(usage);
            service._requestWithBuilderEndpointRouting.mockRejectedValue(Object.assign(new Error('HTTP 402'), {
                response: { status: 402, data: Readable.from(['{"message":"limit reached","reason":"OVERAGE_REQUEST_LIMIT_EXCEEDED"}']) }
            }));
            const error = await service.streamApiReal('', MODEL, request(), false, 0, {}).next().catch(e => e);
            expect(logger[level].mock.calls.map(([line]) => String(line)).join('\n'))
                .toContain('upstream reason: OVERAGE_REQUEST_LIMIT_EXCEEDED');
            // The body is read once and still normalizes into a readable message.
            expect(error.message).toContain('limit reached');
        });

    test.each([
        ['the Kiro header', { 'x-amzn-kiro-ratelimit-retry-after': '90000' }, {}, '90000ms (x-amzn-kiro-ratelimit-retry-after)'],
        ['the payload', {}, { retryAfterMilliseconds: 1500 }, '1500ms (retryAfterMilliseconds)'],
        ['an upstream Retry-After', { 'Retry-After': '7' }, { retryAfterMilliseconds: 1500 }, 'Retry-After 7'],
        ['no source', {}, {}, 'none']
    ])('logs the 429 reason and the retry delay from %s', async (_, headers, extra, delay) => {
        const service = createService(usageWithTrial());
        service._requestWithBuilderEndpointRouting.mockRejectedValue(Object.assign(new Error('HTTP 429'), {
            response: { status: 429, headers: { ...headers }, data: Readable.from([JSON.stringify({ reason: 'DAILY_REQUEST_COUNT', ...extra })]) }
        }));
        await service.streamApiReal('', MODEL, request(), false, 0, {}).next().catch(e => e);
        expect(logger.info.mock.calls.map(([line]) => String(line)).join('\n'))
            .toContain(`Received 429 (Too Many Requests) in stream, reason: DAILY_REQUEST_COUNT, retry delay: ${delay}.`);
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
        expect(error.kiroModelRejected).toBeUndefined();
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
            markKiroModelRejected: jest.fn(),
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
        expect(pool.markKiroModelRejected).toHaveBeenCalledWith('claude-kiro-oauth', 'test-account', MODEL);
        expect(service._markCredentialUnhealthyWithRecovery).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('no alternate credential exists'));
        expect(response.end).toHaveBeenCalled();
    });
});

describe('Kiro (account, model) cooldown after 402 with credits remaining', () => {
    const TYPE = 'claude-kiro-oauth';
    class MemoryPool extends ProviderPoolManager { _debouncedSave() {} _log() {} _logHealthStatusChange() {} }
    const pool = () => new MemoryPool({ [TYPE]: [
        { uuid: 'a', isHealthy: true, KIRO_OAUTH_CREDS_FILE_PATH: '/mock/account-a.json' },
        { uuid: 'b', isHealthy: true, KIRO_OAUTH_CREDS_FILE_PATH: '/mock/account-b.json' }
    ] }, { globalConfig: {} });

    afterEach(() => jest.restoreAllMocks());

    test('skips the rejected account for that model only and keeps it healthy', async () => {
        const manager = pool();
        expect(manager.markKiroModelRejected(TYPE, 'a', MODEL)).toBe(true);
        for (let i = 0; i < 4; i++) {
            expect((await manager.selectProvider(TYPE, MODEL)).uuid).toBe('b');
        }
        const other = new Set();
        for (let i = 0; i < 4; i++) other.add((await manager.selectProvider(TYPE, 'claude-sonnet-4-5')).uuid);
        expect(other.has('a')).toBe(true);
        expect(manager.providerStatus[TYPE].every(provider => provider.config.isHealthy)).toBe(true);
    });

    test('returns no account for the model when every account rejected it', async () => {
        const manager = pool();
        manager.markKiroModelRejected(TYPE, 'a', MODEL);
        manager.markKiroModelRejected(TYPE, 'b', MODEL);
        await expect(manager.selectProvider(TYPE, MODEL)).resolves.toBeNull();
    });

    test('uses the account for the model again after the cooldown expires', async () => {
        const manager = pool();
        const start = Date.now();
        const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
        manager.markKiroModelRejected(TYPE, 'a', MODEL, 1000);
        expect((await manager.selectProvider(TYPE, MODEL)).uuid).toBe('b');
        clock.mockReturnValue(start + 1001);
        const seen = new Set();
        for (let i = 0; i < 4; i++) seen.add((await manager.selectProvider(TYPE, MODEL)).uuid);
        expect(seen.has('a')).toBe(true);
    });

    test('aliases of the same upstream model share the cooldown', async () => {
        const manager = pool();
        manager.markKiroModelRejected(TYPE, 'a', 'claude-opus-4-5');
        for (let i = 0; i < 3; i++) {
            expect((await manager.selectProvider(TYPE, 'claude-opus-4-5-20251101')).uuid).toBe('b');
        }
    });

    test('does not wait on a pending refresh for an account cooled for the model', async () => {
        const manager = pool();
        const [a] = manager.providerStatus[TYPE];
        let finish;
        a.config.needsRefresh = true;
        a.state._refreshTask = { started: true, promise: new Promise(resolve => { finish = resolve; }) };
        manager.markKiroModelRejected(TYPE, 'a', MODEL);

        await expect(manager.waitForPendingKiroRefreshes(TYPE, MODEL)).resolves.toBe(false);

        const other = manager.waitForPendingKiroRefreshes(TYPE, 'claude-sonnet-4-5');
        a.config.needsRefresh = false;
        finish();
        await expect(other).resolves.toBe(true);
    });

    test.each([
        ['KIRO_OAUTH_CREDS_FILE_PATH', '/mock/replacement-account.json'],
        ['KIRO_OAUTH_CREDS_BASE64', Buffer.from('{"accessToken":"replacement"}').toString('base64')],
        ['KIRO_API_KEY', 'ksk_replacement'],
        ['KIRO_BASE_URL', 'https://replacement.invalid/generate']
    ])('changing %s clears the old account rejection on reload', async (field, value) => {
        const manager = pool();
        const a = manager.providerStatus[TYPE][0];
        a.state.activeCount = 1;
        manager.markKiroModelRejected(TYPE, 'a', MODEL);
        manager.providerPools[TYPE][0] = { ...a.config, [field]: value };

        manager.initializeProviderStatus(true);

        expect(manager.providerStatus[TYPE][0].state).toBe(a.state);
        expect(a.state.activeCount).toBe(1);
        expect(a.state._kiroRejectedModels).toBeUndefined();
        expect((await manager.selectProvider(TYPE, MODEL, { excludeUuids: ['b'] })).uuid).toBe('a');
    });

    test.each([
        ['KIRO_OAUTH_CREDS_FILE_PATH', '/mock/direct-replacement.json'],
        ['KIRO_API_KEY', 'ksk_direct_replacement'],
        ['KIRO_BASE_URL', 'https://direct-replacement.invalid/generate']
    ])('selection ignores obsolete rejections immediately after editing %s', async (field, value) => {
        const manager = pool();
        manager.markKiroModelRejected(TYPE, 'a', MODEL);
        manager.providerStatus[TYPE][0].config[field] = value;

        expect((await manager.selectProvider(TYPE, MODEL, { excludeUuids: ['b'] })).uuid).toBe('a');
        expect(manager.providerStatus[TYPE][0].state._kiroRejectedModels).toBeUndefined();
    });

    test('a global upstream change clears account rejections on reload', async () => {
        const manager = pool();
        manager.globalConfig.KIRO_BASE_URL = 'https://old.invalid/generate';
        manager.markKiroModelRejected(TYPE, 'a', MODEL);
        manager.globalConfig.KIRO_BASE_URL = 'https://new.invalid/generate';

        manager.initializeProviderStatus(true);

        expect(manager.providerStatus[TYPE][0].state._kiroRejectedModels).toBeUndefined();
        expect((await manager.selectProvider(TYPE, MODEL, { excludeUuids: ['b'] })).uuid).toBe('a');
    });

    test('normal token refresh, unchanged reload, and UUID rotation retain the account rejection', async () => {
        const manager = pool();
        const a = manager.providerStatus[TYPE][0];
        manager.markKiroModelRejected(TYPE, 'a', MODEL);
        const rejected = a.state._kiroRejectedModels;
        a.config.accessToken = 'rotated-access-token';
        a.state._kiroCredentialVersion = (a.state._kiroCredentialVersion || 0) + 1;
        a.state._kiroCredentialFingerprint = 'rotated-token-fingerprint';
        manager.providerPools[TYPE][0] = { ...a.config };
        manager.initializeProviderStatus(true);
        const rotated = manager.refreshProviderUuid(TYPE, manager.providerStatus[TYPE][0].config);

        expect(rotated).not.toBe('a');
        expect(manager.providerStatus[TYPE][0].state._kiroRejectedModels).toBe(rejected);
        expect((await manager.selectProvider(TYPE, MODEL)).uuid).toBe('b');
        expect(await manager.selectProvider(TYPE, MODEL, { excludeUuids: ['b'] })).toBeNull();
    });

    test('a captured rejection follows its account through reload and UUID rotation', async () => {
        const manager = pool();
        const a = manager.providerStatus[TYPE][0];
        const rejectModel = manager.captureKiroModelRejection(TYPE, 'a');
        manager.providerPools[TYPE][0] = { ...a.config };
        manager.initializeProviderStatus(true);
        const rotated = manager.refreshProviderUuid(TYPE, manager.providerStatus[TYPE][0].config);

        expect(rejectModel(MODEL)).toBe(true);
        expect(manager.providerStatus[TYPE][0].config.uuid).toBe(rotated);
        expect((await manager.selectProvider(TYPE, MODEL)).uuid).toBe('b');
        expect(manager.providerStatus[TYPE][0].config.isHealthy).toBe(true);
    });

    test('an acquired lease cannot reject a replacement account before its handler starts', async () => {
        const manager = pool();
        const acquired = await manager.acquireSlot(TYPE, MODEL, { excludeUuids: ['b'] });
        try {
            manager.providerPools[TYPE][0] = {
                ...manager.providerStatus[TYPE][0].config,
                KIRO_OAUTH_CREDS_FILE_PATH: '/mock/replacement-before-handler.json'
            };
            manager.initializeProviderStatus(true);

            expect(acquired._slotLease.markKiroModelRejected(MODEL)).toBe(false);
            expect((await manager.selectProvider(TYPE, MODEL, { excludeUuids: ['b'] })).uuid).toBe('a');
        } finally {
            acquired._slotLease.release();
        }
        expect(manager.providerStatus[TYPE][0].state.activeCount).toBe(0);
    });

    test('an acquired lease records model rejections before and after UUID rotation', async () => {
        const manager = pool();
        const acquired = await manager.acquireSlot(TYPE, MODEL, { excludeUuids: ['b'] });
        try {
            expect(acquired._slotLease.markKiroModelRejected(MODEL)).toBe(true);
            manager.refreshProviderUuid(TYPE, manager.providerStatus[TYPE][0].config);

            expect(acquired._slotLease.markKiroModelRejected('claude-sonnet-4-5')).toBe(true);
            expect((await manager.selectProvider(TYPE, MODEL)).uuid).toBe('b');
            expect((await manager.selectProvider(TYPE, 'claude-sonnet-4-5')).uuid).toBe('b');
        } finally {
            acquired._slotLease.release();
        }
    });

    test('a queued lease binds rejection results to the configuration granted with its slot', async () => {
        const manager = pool();
        Object.assign(manager.providerStatus[TYPE][0].config, { concurrencyLimit: 1, queueLimit: 1 });
        const first = await manager.acquireSlot(TYPE, MODEL, { excludeUuids: ['b'] });
        const pending = manager.acquireSlot(TYPE, MODEL, { excludeUuids: ['b'] });
        await new Promise(resolve => setImmediate(resolve));
        expect(manager.providerStatus[TYPE][0].state.waitingCount).toBe(1);
        manager.providerPools[TYPE][0] = {
            ...manager.providerStatus[TYPE][0].config,
            KIRO_OAUTH_CREDS_FILE_PATH: '/mock/replacement-before-grant.json'
        };
        manager.initializeProviderStatus(true);
        first._slotLease.release();
        const granted = await pending;
        try {
            expect(granted.KIRO_OAUTH_CREDS_FILE_PATH).toBe('/mock/replacement-before-grant.json');
            expect(granted._slotLease.markKiroModelRejected(MODEL)).toBe(true);
            expect((await manager.selectProvider(TYPE, MODEL)).uuid).toBe('b');
        } finally {
            granted._slotLease.release();
        }
    });

    test('a queued lease from a deleted node cannot reject a new node reusing its UUID', async () => {
        const manager = pool();
        Object.assign(manager.providerStatus[TYPE][0].config, { concurrencyLimit: 1, queueLimit: 1 });
        const first = await manager.acquireSlot(TYPE, MODEL, { excludeUuids: ['b'] });
        const pending = manager.acquireSlot(TYPE, MODEL, { excludeUuids: ['b'] });
        await new Promise(resolve => setImmediate(resolve));
        manager.providerPools[TYPE].splice(0, 1);
        manager.initializeProviderStatus(true);
        manager.providerPools[TYPE].push({ uuid: 'a', isHealthy: true, KIRO_OAUTH_CREDS_FILE_PATH: '/mock/account-a.json' });
        manager.initializeProviderStatus(true);
        first._slotLease.release();
        const granted = await pending;
        try {
            expect(granted._slotLease.markKiroModelRejected(MODEL)).toBe(false);
            expect((await manager.selectProvider(TYPE, MODEL, { excludeUuids: ['b'] })).uuid).toBe('a');
        } finally {
            granted._slotLease.release();
        }
    });

    test.each([
        ['KIRO_OAUTH_CREDS_FILE_PATH', '/mock/rebound-account.json'],
        ['KIRO_API_KEY', 'ksk_rebound_account'],
        ['KIRO_BASE_URL', 'https://rebound.invalid/generate']
    ])('a late rejection cannot contaminate a replacement after %s changes', async (field, value) => {
        const manager = pool();
        const rejectOldModel = manager.captureKiroModelRejection(TYPE, 'a');
        manager.providerPools[TYPE][0] = { ...manager.providerStatus[TYPE][0].config, [field]: value };
        manager.initializeProviderStatus(true);
        manager.markKiroModelRejected(TYPE, 'a', 'claude-haiku-4-5');
        const replacementRejections = manager.providerStatus[TYPE][0].state._kiroRejectedModels;

        expect(rejectOldModel(MODEL)).toBe(false);
        expect(manager.providerStatus[TYPE][0].state._kiroRejectedModels).toBe(replacementRejections);
        expect((await manager.selectProvider(TYPE, MODEL, { excludeUuids: ['b'] })).uuid).toBe('a');
        expect(await manager.selectProvider(TYPE, 'claude-haiku-4-5', { excludeUuids: ['b'] })).toBeNull();
    });

    test('a deleted account callback cannot reject a newly added node with the same UUID', async () => {
        const manager = pool();
        const rejectDeletedModel = manager.captureKiroModelRejection(TYPE, 'a');
        manager.providerPools[TYPE].splice(0, 1);
        manager.initializeProviderStatus(true);
        expect(rejectDeletedModel(MODEL)).toBe(false);
        manager.providerPools[TYPE].push({ uuid: 'a', isHealthy: true, KIRO_OAUTH_CREDS_FILE_PATH: '/mock/account-a.json' });
        manager.initializeProviderStatus(true);

        expect(rejectDeletedModel(MODEL)).toBe(false);
        expect((await manager.selectProvider(TYPE, MODEL, { excludeUuids: ['b'] })).uuid).toBe('a');
    });

    test('ignores non-Kiro providers and unknown accounts', () => {
        const manager = pool();
        expect(manager.markKiroModelRejected('openai-custom', 'a', MODEL)).toBe(false);
        expect(manager.markKiroModelRejected(TYPE, 'missing', MODEL)).toBe(false);
        expect(manager.markKiroModelRejected(TYPE, 'a', '')).toBe(false);
        expect(manager.captureKiroModelRejection('openai-custom', 'a')(MODEL)).toBe(false);
        expect(manager.captureKiroModelRejection(TYPE, 'missing')(MODEL)).toBe(false);
    });
});
