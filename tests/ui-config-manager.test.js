import { jest } from '@jest/globals';

jest.mock('../static/app/utils.js', () => ({
    showToast: jest.fn(), formatUptime: jest.fn(), copyToClipboard: jest.fn(), bindOnce: jest.fn()
}));
jest.mock('../static/app/event-handlers.js', () => ({
    handleProviderChange: jest.fn(), handleGeminiCredsTypeChange: jest.fn(), handleKiroCredsTypeChange: jest.fn()
}));
jest.mock('../static/app/navigation.js', () => ({ loadSectionIfActive: jest.fn(async () => false) }));
jest.mock('../static/app/i18n.js', () => ({ t: key => key }));

import { loadConfiguration, saveConfiguration } from '../static/app/config-manager.js';
import { showToast } from '../static/app/utils.js';

describe('Kiro management form', () => {
    let elements, apiClient, originalDocument, originalWindow;

    beforeEach(() => {
        jest.clearAllMocks();
        originalDocument = global.document;
        originalWindow = global.window;
        const classes = new Set(['selected']);
        const provider = {
            getAttribute: () => 'claude-kiro-oauth',
            querySelector: () => ({ textContent: 'Kiro' }),
            classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) }
        };
        elements = new Map([
            ['modelProvider', { querySelectorAll: () => [provider], appendChild: jest.fn() }],
            ['kiroDynamicModels', { checked: false }],
            ['kiroModelCacheTtlMs', { value: '300000', focus: jest.fn() }],
            ['kiroRefreshAheadMinutes', { value: '10', focus: jest.fn() }],
            ['kiroRefreshJitterMs', { value: '30000', focus: jest.fn() }],
            ['kiroRefreshWaitTimeoutMs', { value: '15000', focus: jest.fn() }]
        ]);
        apiClient = { get: jest.fn(async () => ({})), post: jest.fn(async () => ({})) };
        global.document = {
            getElementById: id => elements.get(id) || null,
            querySelectorAll: () => []
        };
        global.window = { apiClient };
    });

    afterEach(() => {
        if (originalDocument === undefined) delete global.document;
        else global.document = originalDocument;
        if (originalWindow === undefined) delete global.window;
        else global.window = originalWindow;
    });

    test('loads configured values and submits edits before reloading the service configuration', async () => {
        apiClient.get.mockResolvedValue({
            KIRO_DYNAMIC_MODELS: true, KIRO_MODEL_CACHE_TTL_MS: 0,
            KIRO_REFRESH_AHEAD_MINUTES: 2.5, KIRO_REFRESH_JITTER_MS: 0,
            KIRO_REFRESH_WAIT_TIMEOUT_MS: 45000
        });
        await loadConfiguration();
        expect(elements.get('kiroDynamicModels').checked).toBe(true);
        expect(Number(elements.get('kiroModelCacheTtlMs').value)).toBe(0);
        expect(Number(elements.get('kiroRefreshJitterMs').value)).toBe(0);
        expect(Number(elements.get('kiroRefreshAheadMinutes').value)).toBe(2.5);
        expect(Number(elements.get('kiroRefreshWaitTimeoutMs').value)).toBe(45000);

        elements.get('kiroDynamicModels').checked = false;
        elements.get('kiroRefreshAheadMinutes').value = '1.25';
        await saveConfiguration();
        expect(apiClient.post).toHaveBeenNthCalledWith(1, '/config', expect.objectContaining({
            KIRO_DYNAMIC_MODELS: false, KIRO_MODEL_CACHE_TTL_MS: 0,
            KIRO_REFRESH_AHEAD_MINUTES: 1.25, KIRO_REFRESH_JITTER_MS: 0,
            KIRO_REFRESH_WAIT_TIMEOUT_MS: 45000
        }));
        expect(apiClient.post).toHaveBeenNthCalledWith(2, '/reload-config');
        expect(showToast).toHaveBeenCalledWith('common.success', 'common.configSaved', 'success');
    });

    test('uses defaults for missing settings while retaining an explicitly disabled switch', async () => {
        elements.get('kiroDynamicModels').checked = true;
        for (const [id, input] of elements) {
            if (id.startsWith('kiro') && id !== 'kiroDynamicModels') input.value = '';
        }
        await loadConfiguration();
        await saveConfiguration();
        expect(apiClient.post).toHaveBeenCalledWith('/config', expect.objectContaining({
            KIRO_DYNAMIC_MODELS: false, KIRO_MODEL_CACHE_TTL_MS: 300000,
            KIRO_REFRESH_AHEAD_MINUTES: 10, KIRO_REFRESH_JITTER_MS: 30000,
            KIRO_REFRESH_WAIT_TIMEOUT_MS: 15000
        }));
    });

    test.each([
        ['kiroModelCacheTtlMs', ''], ['kiroModelCacheTtlMs', '-1'], ['kiroModelCacheTtlMs', '1.5'],
        ['kiroRefreshAheadMinutes', '0'], ['kiroRefreshAheadMinutes', 'invalid'],
        ['kiroRefreshJitterMs', '-1'], ['kiroRefreshWaitTimeoutMs', '0'],
        ['kiroRefreshWaitTimeoutMs', '2147483648']
    ])('blocks an invalid %s value %p before submitting any configuration', async (id, value) => {
        elements.get(id).value = value;
        await saveConfiguration();
        expect(apiClient.post).not.toHaveBeenCalled();
        expect(elements.get(id).focus).toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('common.error', 'config.kiroSettings.invalidNumber', 'error');
    });
});
