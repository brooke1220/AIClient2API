import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(), invalidateServiceAdapter: jest.fn(), serviceInstances: {}
}));
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { initApiService, getProviderPoolManager } from '../src/services/service-manager.js';
import { getServiceAdapter } from '../src/providers/adapter.js';

test('service reload applies new global settings before reusing account state', async () => {
    jest.spyOn(ProviderPoolManager.prototype, '_debouncedSave').mockImplementation(() => {});
    try {
        const type = 'claude-kiro-oauth';
        const config = { KIRO_DYNAMIC_MODELS: true, KIRO_MODELS_URL: 'https://old.invalid/models',
            providerPools: { [type]: [{ uuid: 'a', KIRO_OAUTH_CREDS_FILE_PATH: '/mock/a.json' }] } };
        await initApiService(config);
        const manager = getProviderPoolManager(), state = manager.providerStatus[type][0].state;
        state.activeCount = 1;
        manager.updateKiroModelCapabilities(type, 'a', ['old-model'], 60000);
        const updated = { ...config, KIRO_MODELS_URL: 'https://new.invalid/models',
            KIRO_ACCOUNT_REQUESTS_PER_MINUTE: 5, providerPools: { [type]: [{ ...config.providerPools[type][0] }] } };
        await initApiService(updated);
        expect(getProviderPoolManager()).toBe(manager);
        expect(manager.globalConfig).toBe(updated);
        expect(manager.providerStatus[type][0].state).toBe(state);
        expect(state.activeCount).toBe(1);
        expect(state._kiroDiscoveredModels).toBeUndefined();
    } finally { jest.restoreAllMocks(); }
});

test('reloaded cache settings reach new adapters while explicit account overrides take precedence', async () => {
    jest.spyOn(ProviderPoolManager.prototype, '_debouncedSave').mockImplementation(() => {});
    try {
        const type = 'claude-kiro-oauth';
        const config = { KIRO_PROMPT_CACHE_MODE: 'off', KIRO_PROMPT_CACHE_POLICY: 'auto',
            KIRO_PROMPT_CACHE_DEFAULT_TTL_MS: 300000, KIRO_PROMPT_CACHE_MAX_ENTRIES: 65536,
            KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: { 'claude-sonnet-4.5': 1024 },
            providerPools: { [type]: [
                { uuid: 'cache-global', KIRO_OAUTH_CREDS_FILE_PATH: '/mock/a.json' },
                { uuid: 'cache-override', KIRO_OAUTH_CREDS_FILE_PATH: '/mock/b.json', KIRO_PROMPT_CACHE_MODE: 'observe',
                    KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: { 'claude-sonnet-4.5': 4096 } }
            ] } };
        await initApiService(config);
        const updated = { ...config, KIRO_PROMPT_CACHE_MODE: 'estimate', KIRO_PROMPT_CACHE_POLICY: 'history',
            KIRO_PROMPT_CACHE_DEFAULT_TTL_MS: 1001, KIRO_PROMPT_CACHE_MAX_ENTRIES: 2048,
            KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: { 'claude-sonnet-4.5': 2048 } };
        await initApiService(updated);
        const calls = getServiceAdapter.mock.calls.slice(-2).map(([node]) => node);
        expect(calls.find(node => node.uuid === 'cache-global')).toMatchObject({
            KIRO_PROMPT_CACHE_MODE: 'estimate', KIRO_PROMPT_CACHE_POLICY: 'history',
            KIRO_PROMPT_CACHE_DEFAULT_TTL_MS: 1001, KIRO_PROMPT_CACHE_MAX_ENTRIES: 2048,
            KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: { 'claude-sonnet-4.5': 2048 }
        });
        expect(calls.find(node => node.uuid === 'cache-override')).toMatchObject({
            KIRO_PROMPT_CACHE_MODE: 'observe', KIRO_PROMPT_CACHE_POLICY: 'history',
            KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: { 'claude-sonnet-4.5': 4096 }
        });
    } finally { jest.restoreAllMocks(); }
});
