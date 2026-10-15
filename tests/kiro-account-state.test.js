import { getEventListeners } from 'node:events';
import { jest } from '@jest/globals';

jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../src/providers/adapter.js', () => ({ getServiceAdapter: jest.fn(), getRegisteredProviders: () => [], invalidateServiceAdapter: jest.fn(), serviceInstances: {} }));

import { getServiceAdapter } from '../src/providers/adapter.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { acquireProviderSlot } from '../src/providers/provider-slot-lease.js';
import { isKiroProviderType } from '../src/providers/kiro-account-state.js';

const TYPE = 'claude-kiro-oauth';
const MODEL = 'claude-sonnet-4-5';
const tick = () => new Promise(resolve => setImmediate(resolve));
class MemoryPool extends ProviderPoolManager {
    _debouncedSave() {}
    _log() {}
    _logHealthStatusChange() {}
}
function createPool(config = {}, type = TYPE) {
    const pool = new MemoryPool({ [type]: [{ uuid: 'account', isHealthy: true, concurrencyLimit: 1, queueLimit: 5, ...config }] }, {
        globalConfig: { SCHEDULED_HEALTH_CHECK: { enabled: true, providerTypes: [type], interval: 600000 } }
    });
    return { pool, node: pool.providerStatus[type][0], config: pool.providerStatus[type][0].config, type };
}
function upstreamFor(pool, type = TYPE) {
    const generateContent = jest.fn(async (_, __, options) => {
        pool.assertProviderAvailable(type, 'account', { allowUnhealthy: options?.kiroHealthCheck === true, manualRecovery: options?.kiroManualRecovery === true });
        return {};
    });
    getServiceAdapter.mockReturnValue({ generateContent });
    return generateContent;
}

beforeEach(() => jest.clearAllMocks());

describe('Kiro account availability uses authoritative pool state', () => {
    test.each([TYPE, `${TYPE}-team`])('guards Kiro provider %s and permits standalone calls', type => {
        const { pool, config } = createPool({ isHealthy: false }, type);
        expect(() => pool.assertProviderAvailable(type, config.uuid)).toThrow(/unhealthy/);
        expect(() => pool.assertProviderAvailable(type, 'standalone')).not.toThrow();
        expect(() => pool.assertProviderAvailable(type, null)).not.toThrow();
    });

    test.each(['claude-custom', 'claude-kiro', 'claude-kiro-oauthish', undefined, 10])('does not match other provider %p', type => {
        expect(isKiroProviderType(type)).toBe(false);
    });

    test.each([
        { isHealthy: false }, { isDisabled: true }, { needsRefresh: true },
        { scheduledRecoveryTime: new Date(Date.now() + 3600000).toISOString() },
        { lastErrorMessage: 'Your User ID temporarily is suspended' }
    ])('prevents direct slot acquisition for paused Kiro state %p', async state => {
        const { node } = createPool(state);
        // Startup intentionally clears stale refresh flags; exercise a live pause.
        if (state.needsRefresh) node.config.needsRefresh = true;
        await expect(acquireProviderSlot(node)).rejects.toMatchObject({ code: 'KIRO_ACCOUNT_UNAVAILABLE', skipErrorCount: true, shouldSwitchCredential: false });
        expect(node.state.activeCount).toBe(0);
    });

    test.each(['suspend', 'cooldown', 'disabled', 'refresh'])('rejects all queued work immediately on %s', async change => {
        const { pool, node, config } = createPool();
        pool._enqueueRefresh = jest.fn();
        const first = await pool.acquireSlot(TYPE, MODEL);
        const controller = new AbortController();
        const waiting = [pool.acquireSlot(TYPE, MODEL, { signal: controller.signal }), pool.acquireSlot(TYPE, MODEL)];
        const failures = waiting.map(promise => expect(promise).rejects.toMatchObject({ code: 'KIRO_ACCOUNT_UNAVAILABLE' }));
        await tick();
        expect(node.state.waitingCount).toBe(2);
        if (change === 'suspend') pool.markProviderUnhealthyImmediately(TYPE, config, '403 TEMPORARILY_SUSPENDED');
        if (change === 'cooldown') pool.markProviderUnhealthyWithRecoveryTime(TYPE, config, '429', new Date(Date.now() + 60000));
        if (change === 'disabled') pool.disableProvider(TYPE, config);
        if (change === 'refresh') pool.markProviderNeedRefresh(TYPE, config);
        await Promise.all(failures);
        expect(node.state.waitingCount).toBe(0);
        expect(node.state.queue).toHaveLength(0);
        expect(node.state.activeCount).toBe(1);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        first._slotLease.release();
        expect(node.state.activeCount).toBe(0);
    });

    test('rechecks after hot reload before handing an old queue a slot', async () => {
        const { pool, node, config } = createPool();
        const first = await pool.acquireSlot(TYPE, MODEL);
        const waiting = pool.acquireSlot(TYPE, MODEL);
        const failure = expect(waiting).rejects.toMatchObject({ code: 'KIRO_ACCOUNT_UNAVAILABLE' });
        await tick();
        pool.providerPools[TYPE] = [{ ...config, isDisabled: true }];
        pool.initializeProviderStatus();
        expect(node.state._slotConfig).toBe(pool.providerStatus[TYPE][0].config);
        expect(() => first._slotLease.assertUsable()).toThrow(/disabled/);
        first._slotLease.release();
        await failure;
        expect(node.state.activeCount).toBe(0);
    });

    test('leaves other provider queues and post-selection behavior unchanged', async () => {
        const type = 'claude-custom';
        const { pool, node, config } = createPool({}, type);
        const first = await pool.acquireSlot(type, MODEL);
        const waiting = pool.acquireSlot(type, MODEL);
        await tick();
        pool.markProviderUnhealthyImmediately(type, config, '403 temporarily suspended');
        expect(node.state.waitingCount).toBe(1);
        expect(() => pool.assertProviderAvailable(type, config.uuid)).not.toThrow();
        first._slotLease.release();
        const acquired = await waiting;
        expect(node.state.activeCount).toBe(1);
        acquired._slotLease.release();
    });
});

describe('Kiro health checks and manual recovery', () => {
    test.each(['performInitialHealthChecks', 'performHealthChecks'])('%s respects strong pauses while probing ordinary failures', async method => {
        const { pool } = createPool();
        pool.providerPools[TYPE] = [
            { uuid: 'cooldown', isHealthy: false, scheduledRecoveryTime: new Date(Date.now() + 3600000).toISOString() },
            { uuid: 'suspended', isHealthy: false, lastErrorMessage: '403 temporarily suspended' },
            { uuid: 'disabled', isDisabled: true }, { uuid: 'refresh', needsRefresh: true },
            { uuid: 'ordinary', isHealthy: false, lastErrorTime: new Date(0).toISOString() }
        ];
        pool.initializeProviderStatus();
        pool._checkProviderHealth = jest.fn(async () => ({ success: true, modelName: MODEL }));
        await pool[method]();
        expect(pool._checkProviderHealth.mock.calls.map(([, config]) => config.uuid)).toEqual(['ordinary']);
    });

    test('old successes, refresh resets, reloads and timers cannot clear a suspension', async () => {
        const { pool, config } = createPool();
        pool.markProviderUnhealthyImmediately(TYPE, config, '403 temporarily suspended');
        config.scheduledRecoveryTime = new Date(0).toISOString();
        pool.markProviderHealthy(TYPE, config);
        pool.resetProviderRefreshStatus(TYPE, config.uuid);
        pool._checkAndRecoverScheduledProviders(TYPE);
        pool.initializeProviderStatus();
        expect(() => pool.assertProviderAvailable(TYPE, config.uuid)).toThrow(/manual recovery/);
        expect(config.kiroAccountSuspended).toBe(true);
        pool.enableProvider(TYPE, config);
        expect(() => pool.assertProviderAvailable(TYPE, config.uuid)).not.toThrow();
    });

    test('an older success or refresh reset cannot shorten a Kiro cooldown', () => {
        const recovery = new Date(Date.now() + 3600000).toISOString();
        const { pool, config } = createPool({ isHealthy: false, scheduledRecoveryTime: recovery });
        pool.markProviderHealthy(TYPE, config);
        pool.resetProviderRefreshStatus(TYPE, config.uuid);
        expect(config.isHealthy).toBe(false);
        expect(config.scheduledRecoveryTime).toBe(recovery);
    });

    test('only successful explicit manual detection can clear suspension', async () => {
        const { pool, config } = createPool();
        pool.markProviderUnhealthyImmediately(TYPE, config, '403 account suspended');
        const generateContent = upstreamFor(pool);
        await expect(pool._checkProviderHealth(TYPE, config)).rejects.toMatchObject({ code: 'KIRO_ACCOUNT_UNAVAILABLE' });
        const result = await pool._checkProviderHealth(TYPE, config, { manualRecovery: true });
        expect(result.success).toBe(true);
        expect(config.kiroAccountSuspended).toBe(true);
        expect(generateContent).toHaveBeenCalledWith(MODEL, expect.any(Object), expect.objectContaining({ kiroHealthCheck: true, kiroManualRecovery: true }));
        expect(JSON.stringify(result)).not.toContain('kiroRecoverySnapshot');
        pool.markProviderHealthy(TYPE, config, false, MODEL, { manualRecovery: true, kiroRecoverySnapshot: result.kiroRecoverySnapshot });
        expect(config.kiroAccountSuspended).toBe(false);
        expect(() => pool.assertProviderAvailable(TYPE, config.uuid)).not.toThrow();
    });

    test('failed manual detection leaves suspension in place', async () => {
        const { pool, config } = createPool();
        pool.markProviderUnhealthyImmediately(TYPE, config, '403 account suspended');
        getServiceAdapter.mockReturnValue({ generateContent: jest.fn(async () => { throw new Error('upstream still suspended'); }) });
        const result = await pool._checkProviderHealth(TYPE, config, { manualRecovery: true });
        expect(result.success).toBe(false);
        expect(config.kiroAccountSuspended).toBe(true);
        expect(config.isHealthy).toBe(false);
    });

    test.each([{ isDisabled: true }, { needsRefresh: true }])('manual detection cannot bypass %p', async state => {
        const { pool, config } = createPool({ ...state, kiroAccountSuspended: true });
        if (state.needsRefresh) config.needsRefresh = true;
        await expect(pool._checkProviderHealth(TYPE, config, { manualRecovery: true })).rejects.toMatchObject({ code: 'KIRO_ACCOUNT_UNAVAILABLE' });
        pool.markProviderHealthy(TYPE, config, false, MODEL, { manualRecovery: true });
        expect(config.kiroAccountSuspended).toBe(true);
        expect(getServiceAdapter).not.toHaveBeenCalled();
    });

    test('automatic token refresh is skipped for suspended Kiro accounts', async () => {
        const { pool, node, config } = createPool({ kiroAccountSuspended: true, isHealthy: false });
        await pool._refreshNodeToken(TYPE, node, true);
        pool.resetProviderRefreshStatus(TYPE, config.uuid);
        expect(getServiceAdapter).not.toHaveBeenCalled();
        expect(config.kiroAccountSuspended).toBe(true);
    });

    test('an in-flight refresh cannot clear a newer pause', async () => {
        const { pool, node, config } = createPool();
        config.needsRefresh = true;
        let finishRefresh;
        const refresh = new Promise(resolve => { finishRefresh = resolve; });
        getServiceAdapter.mockReturnValue({ refreshToken: jest.fn(() => refresh) });
        const pending = pool._refreshNodeToken(TYPE, node);
        await tick();
        pool.markProviderUnhealthyImmediately(TYPE, config, '403 TEMPORARILY_SUSPENDED');
        finishRefresh(true);
        await pending;
        expect(config.kiroAccountSuspended).toBe(true);
        expect(config.isHealthy).toBe(false);
        expect(() => pool.assertProviderAvailable(TYPE, config.uuid)).toThrow(/manual recovery/);
    });

    test('manual reset clears a stale suspension and scheduled recovery time', () => {
        const { pool, config } = createPool({ kiroAccountSuspended: true, isHealthy: false, scheduledRecoveryTime: new Date(Date.now() + 60000).toISOString() });
        pool.resetAllHealthInType(TYPE);
        expect(config.scheduledRecoveryTime).toBeNull();
        expect(() => pool.assertProviderAvailable(TYPE, config.uuid)).not.toThrow();
    });

    test('does not add Kiro health-check flags to another provider', async () => {
        const type = 'claude-custom';
        const { pool, config } = createPool({}, type);
        const generateContent = jest.fn(async () => ({}));
        getServiceAdapter.mockReturnValue({ generateContent });
        await pool._checkProviderHealth(type, config);
        expect(generateContent.mock.calls[0]).toHaveLength(2);
    });

    test('a health probe paused immediately before sending preserves the new refresh state', async () => {
        const { pool, config } = createPool();
        getServiceAdapter.mockReturnValue({ generateContent: jest.fn(async () => {
            config.needsRefresh = true;
            pool.assertProviderAvailable(TYPE, config.uuid, { allowUnhealthy: true });
        }) });
        await pool.performHealthChecks();
        expect(config.needsRefresh).toBe(true);
        expect(config.errorCount).toBe(0);
    });

    test.each(['suspended', 'cooldown', 'disabled', 'refresh'])('an older successful manual probe cannot clear a new %s pause', async change => {
        const { pool, config } = createPool();
        pool.markProviderUnhealthyImmediately(TYPE, config, '403 TEMPORARILY_SUSPENDED');
        const originalErrorTime = config.lastErrorTime;
        pool._enqueueRefresh = jest.fn();
        let completeProbe;
        const probe = new Promise(resolve => { completeProbe = resolve; });
        const generateContent = jest.fn(() => probe);
        getServiceAdapter.mockReturnValue({ generateContent });
        const pending = pool._checkProviderHealth(TYPE, config, { manualRecovery: true });
        const failure = expect(pending).rejects.toMatchObject({ code: 'KIRO_ACCOUNT_UNAVAILABLE' });
        await tick();
        expect(generateContent).toHaveBeenCalledTimes(1);
        if (change === 'suspended') {
            pool.markProviderUnhealthyImmediately(TYPE, config, '403 TEMPORARILY_SUSPENDED');
            // Two identical upstream responses can arrive in the same millisecond.
            config.lastErrorTime = originalErrorTime;
        }
        if (change === 'cooldown') pool.markProviderUnhealthyWithRecoveryTime(TYPE, config, '429', new Date(Date.now() + 120000));
        if (change === 'disabled') pool.disableProvider(TYPE, config);
        if (change === 'refresh') config.needsRefresh = true;
        completeProbe({});
        await failure;
        expect(config.kiroAccountSuspended).toBe(true);
        expect(config.isHealthy).toBe(false);
    });

    test.each([TYPE, `${TYPE}-team`, 'claude-custom'])('overlapping cooldowns preserve the longest deadline only for Kiro: %s', type => {
        const { pool, config } = createPool({}, type);
        const long = new Date(Date.now() + 120000);
        const short = new Date(Date.now() + 1000);
        pool.markProviderUnhealthyWithRecoveryTime(type, config, '429', long);
        pool.markProviderUnhealthyWithRecoveryTime(type, config, '429', short);
        expect(config.scheduledRecoveryTime).toBe((isKiroProviderType(type) ? long : short).toISOString());
    });

    test('an older disk snapshot cannot clear live Kiro pauses during a configuration edit', () => {
        const { pool, node, config } = createPool();
        const diskSnapshot = { ...config };
        const recovery = new Date(Date.now() + 120000).toISOString();
        pool.markProviderUnhealthyWithRecoveryTime(TYPE, config, '429', recovery);
        config.needsRefresh = true;
        const version = node.state._kiroPauseVersion;
        pool.providerPools[TYPE] = [{ ...diskSnapshot, customName: 'renamed' }];
        pool.initializeProviderStatus();
        const updated = pool.providerStatus[TYPE][0];
        expect(updated.config.customName).toBe('renamed');
        expect(updated.config.scheduledRecoveryTime).toBe(recovery);
        expect(updated.config.needsRefresh).toBe(true);
        expect(updated.config.isHealthy).toBe(false);
        expect(updated.state._kiroPauseVersion).toBe(version);
        expect(() => pool.assertProviderAvailable(TYPE, config.uuid)).toThrow(/refresh/);
    });

    test('an explicit reset is not undone by reloading an older paused disk snapshot', () => {
        const { pool, config } = createPool();
        pool.markProviderUnhealthyImmediately(TYPE, config, '403 account suspended');
        const pausedDiskSnapshot = { ...config };
        pool.resetAllHealthInType(TYPE);
        pool.providerPools[TYPE] = [{ ...pausedDiskSnapshot, customName: 'renamed' }];
        pool.initializeProviderStatus(true);
        expect(() => pool.assertProviderAvailable(TYPE, config.uuid)).not.toThrow();
        expect(pool.providerStatus[TYPE][0].config.kiroAccountSuspended).toBe(false);
    });

    test.each([TYPE, 'claude-custom'])('old configuration edits preserve runtime disable only for Kiro: %s', type => {
        const { pool, config } = createPool({}, type);
        const oldDisk = { ...config };
        pool.disableProvider(type, config);
        pool.providerPools[type] = [{ ...oldDisk, customName: 'renamed' }];
        pool.initializeProviderStatus();
        const current = pool.providerStatus[type][0].config;
        expect(current.isDisabled).toBe(isKiroProviderType(type));
        pool.enableProvider(type, current);
        expect(current.isDisabled).toBe(false);
        if (isKiroProviderType(type)) expect(() => pool.assertProviderAvailable(type, current.uuid)).not.toThrow();
    });

    test.each(['suspended', 'cooldown', 'disabled', 'refresh'])('manual recovery commits recheck a new %s after probe completion', async change => {
        const { pool, config } = createPool();
        pool.markProviderUnhealthyImmediately(TYPE, config, '403 account suspended');
        upstreamFor(pool);
        const result = await pool._checkProviderHealth(TYPE, config, { manualRecovery: true });
        if (change === 'suspended') pool.markProviderUnhealthyImmediately(TYPE, config, '403 account suspended');
        if (change === 'cooldown') pool.markProviderUnhealthyWithRecoveryTime(TYPE, config, '429', new Date(Date.now() + 120000));
        if (change === 'disabled') pool.disableProvider(TYPE, config);
        if (change === 'refresh') config.needsRefresh = true;
        expect(() => pool.markProviderHealthy(TYPE, config, false, MODEL, {
            manualRecovery: true, kiroRecoverySnapshot: result.kiroRecoverySnapshot
        })).toThrow(/unavailable/);
        expect(config.kiroAccountSuspended).toBe(true);
        expect(config.isHealthy).toBe(false);
    });
});
