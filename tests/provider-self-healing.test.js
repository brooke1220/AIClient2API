import { jest } from '@jest/globals';

jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../src/providers/adapter.js', () => ({ getServiceAdapter: jest.fn(), getRegisteredProviders: () => [], invalidateServiceAdapter: jest.fn(), serviceInstances: {} }));
jest.mock('../src/providers/gemini/antigravity-core.js', () => ({ isAntigravityModelRetired: () => false }));

import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

const KIRO = 'claude-kiro-oauth';
const MODEL = 'claude-sonnet-4-5';
class MemoryPool extends ProviderPoolManager {
    _debouncedSave() {}
    _log() {}
}

function createPool(type = KIRO, accounts = [{}]) {
    const pool = new MemoryPool({ [type]: accounts.map((config, index) => ({ uuid: `account-${index}`, ...config })) });
    for (const node of pool.providerStatus[type]) {
        Object.assign(node.config, { isHealthy: false, errorCount: 10, refreshCount: 2,
            lastErrorTime: new Date().toISOString(), lastErrorMessage: 'Upstream temporarily unavailable' });
    }
    return pool;
}

describe('provider self-healing during selection', () => {
    test.each([
        ['openai-custom', 'gpt-5.5'], [KIRO, MODEL], [`${KIRO}-team`, MODEL], [KIRO, null]
    ])('recovers an ordinary failed %s account for model %s', async (type, model) => {
        const pool = createPool(type);
        await expect(pool.selectProvider(type, model)).resolves.toMatchObject({ uuid: 'account-0', isHealthy: true,
            errorCount: 0, refreshCount: 0, lastErrorTime: null, lastErrorMessage: null });
    });

    test.each([
        ['disabled', { isDisabled: true }], ['suspended', { kiroAccountSuspended: true }],
        ['suspension message', { lastErrorMessage: '403 Your User ID temporarily is suspended' }],
        ['cooldown', { scheduledRecoveryTime: new Date(Date.now() + 3600000).toISOString() }],
        ['awaiting refresh', { needsRefresh: true }]
    ])('preserves the %s pause and failure history', async (_label, state) => {
        const pool = createPool();
        const config = pool.providerStatus[KIRO][0].config;
        Object.assign(config, state);
        const original = { ...config };
        await expect(pool.selectProvider(KIRO, MODEL)).resolves.toBeNull();
        expect(config).toEqual(original);
    });

    test('does not reset an account while its refresh is running', async () => {
        const pool = createPool();
        pool.refreshingUuids.add('account-0');
        await expect(pool.selectProvider(KIRO, MODEL)).resolves.toBeNull();
        expect(pool.providerStatus[KIRO][0].config).toMatchObject({ isHealthy: false, errorCount: 10, refreshCount: 2 });
    });

    test('does not recover excluded accounts', async () => {
        const pool = createPool();
        await expect(pool.selectProvider(KIRO, MODEL, { excludeUuids: ['account-0'] })).resolves.toBeNull();
        expect(pool.providerStatus[KIRO][0].config.isHealthy).toBe(false);
    });

    test.each([
        [KIRO, { notSupportedModels: [MODEL] }], ['openai-custom', { supportedModels: ['different-model'] }]
    ])('leaves failed %s accounts untouched when they do not support the requested model', async (type, config) => {
        const pool = createPool(type, [config]);
        await expect(pool.selectProvider(type, MODEL)).resolves.toBeNull();
        expect(pool.providerStatus[type][0].config).toMatchObject({ isHealthy: false, errorCount: 10 });
    });

    test('recovers only matching accounts when another healthy account cannot serve the model', async () => {
        const pool = createPool(KIRO, [{ notSupportedModels: [MODEL] }, {}, { notSupportedModels: [MODEL] }]);
        pool.providerStatus[KIRO][0].config.isHealthy = true;
        await expect(pool.selectProvider(KIRO, MODEL)).resolves.toMatchObject({ uuid: 'account-1' });
        expect(pool.providerStatus[KIRO][2].config.isHealthy).toBe(false);
    });

    test('does not recover an Antigravity account whose requested quota family is exhausted', async () => {
        const type = 'gemini-antigravity';
        const pool = createPool(type, [{ quotaExhaustionByFamily: { gemini: new Date(Date.now() + 3600000).toISOString() } }]);
        await expect(pool.selectProvider(type, 'gemini-3.8-flash-low')).resolves.toBeNull();
        expect(pool.providerStatus[type][0].config.isHealthy).toBe(false);
    });
});
