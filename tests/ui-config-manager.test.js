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
import { showToast, bindOnce } from '../static/app/utils.js';

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
            ['kiroRefreshWaitTimeoutMs', { value: '15000', focus: jest.fn() }],
            ['kiroPromptCacheMode', { value: 'off', focus: jest.fn() }],
            ['kiroPromptCachePolicy', { value: 'auto', focus: jest.fn() }],
            ['kiroPromptCacheTtlSeconds', { value: '300', focus: jest.fn() }],
            ['kiroPromptCacheMaxEntries', { value: '65536', focus: jest.fn() }],
            ['kiroPromptCacheAddModel', {}]
        ]);
        const modelRows = {
            rows: [],
            replaceChildren() { this.rows = []; },
            appendChild(row) { this.rows.push(row); },
            querySelectorAll() { return this.rows; }
        };
        elements.set('kiroPromptCacheModels', modelRows);
        apiClient = { get: jest.fn(async () => ({})), post: jest.fn(async () => ({})) };
        global.document = {
            getElementById: id => elements.get(id) || null,
            querySelectorAll: () => [],
            createElement: () => {
                const fields = new Map(['.kiro-cache-model-id', '.kiro-cache-model-minimum'].map(key => [key, { value: '', focus: jest.fn() }]));
                const remove = { addEventListener: (event, handler) => { remove.click = handler; } };
                fields.set('.kiro-cache-model-remove', remove);
                const row = { querySelector: key => fields.get(key), remove: () => { modelRows.rows = modelRows.rows.filter(item => item !== row); } };
                return row;
            }
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
            KIRO_REFRESH_WAIT_TIMEOUT_MS: 15000,
            KIRO_PROMPT_CACHE_MODE: 'off', KIRO_PROMPT_CACHE_POLICY: 'auto',
            KIRO_PROMPT_CACHE_DEFAULT_TTL_MS: 300000, KIRO_PROMPT_CACHE_MAX_ENTRIES: 65536,
            KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: {}
        }));
    });

    test('loads all cache controls, converts seconds and preserves exact model overrides', async () => {
        const map = { 'claude-sonnet-4.5': 1536, 'claude-opus-4.5': 8192 };
        apiClient.get.mockResolvedValue({ KIRO_PROMPT_CACHE_MODE: 'observe', KIRO_PROMPT_CACHE_POLICY: 'explicit',
            KIRO_PROMPT_CACHE_DEFAULT_TTL_MS: 1001, KIRO_PROMPT_CACHE_MAX_ENTRIES: 4096, KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: map });
        await loadConfiguration();
        expect(elements.get('kiroPromptCacheMode').value).toBe('observe');
        expect(Number(elements.get('kiroPromptCacheTtlSeconds').value)).toBe(1.001);
        expect(elements.get('kiroPromptCacheModels').rows).toHaveLength(2);
        await saveConfiguration();
        expect(apiClient.post).toHaveBeenNthCalledWith(1, '/config', expect.objectContaining({
            KIRO_PROMPT_CACHE_MODE: 'observe', KIRO_PROMPT_CACHE_POLICY: 'explicit',
            KIRO_PROMPT_CACHE_DEFAULT_TTL_MS: 1001, KIRO_PROMPT_CACHE_MAX_ENTRIES: 4096,
            KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: map
        }));
        expect(apiClient.post).toHaveBeenNthCalledWith(2, '/reload-config');
        await loadConfiguration();
        expect(elements.get('kiroPromptCacheModels').rows).toHaveLength(2);
    });

    test('adds, edits and deletes model rows and submits an empty map when all rows are removed', async () => {
        await loadConfiguration();
        const addRow = bindOnce.mock.calls.find(call => call[3] === 'kiroPromptCacheAddModel')[2];
        addRow();
        const container = elements.get('kiroPromptCacheModels');
        const row = container.rows[0];
        expect(row.querySelector('.kiro-cache-model-id').focus).toHaveBeenCalled();
        row.querySelector('.kiro-cache-model-id').value = ' claude-sonnet-4.5 ';
        row.querySelector('.kiro-cache-model-minimum').value = '2048';
        elements.get('kiroPromptCacheMode').value = 'estimate';
        elements.get('kiroPromptCachePolicy').value = 'history';
        await saveConfiguration();
        expect(apiClient.post).toHaveBeenCalledWith('/config', expect.objectContaining({ KIRO_PROMPT_CACHE_MODE: 'estimate',
            KIRO_PROMPT_CACHE_POLICY: 'history', KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: { 'claude-sonnet-4.5': 2048 } }));
        row.querySelector('.kiro-cache-model-remove').click();
        expect(container.rows).toHaveLength(0);
        apiClient.post.mockClear();
        await saveConfiguration();
        expect(apiClient.post).toHaveBeenCalledWith('/config', expect.objectContaining({ KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: {} }));
    });

    test.each(['', '0', '-1', '1.5', '9007199254740992', 'invalid'])('blocks invalid model minimum %p before saving', async minimum => {
        apiClient.get.mockResolvedValue({ KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: { model: 1024 } });
        await loadConfiguration();
        const input = elements.get('kiroPromptCacheModels').rows[0].querySelector('.kiro-cache-model-minimum');
        input.value = minimum;
        await saveConfiguration();
        expect(apiClient.post).not.toHaveBeenCalled();
        expect(input.focus).toHaveBeenCalled();
    });

    test.each(['', ' model-a ', '__proto__', 'constructor'])('blocks empty, repeated or reserved model ID %p', async model => {
        apiClient.get.mockResolvedValue({ KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: { 'model-a': 1024, 'model-b': 2048 } });
        await loadConfiguration();
        const input = elements.get('kiroPromptCacheModels').rows[1].querySelector('.kiro-cache-model-id');
        input.value = model;
        await saveConfiguration();
        expect(apiClient.post).not.toHaveBeenCalled();
        expect(input.focus).toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('common.error', 'config.kiroSettings.cacheInvalidModel', 'error');
    });

    test.each(['kiroPromptCacheMode', 'kiroPromptCachePolicy'])('blocks an invalid %s choice', async id => {
        elements.get(id).value = 'invalid';
        await saveConfiguration();
        expect(apiClient.post).not.toHaveBeenCalled();
        expect(elements.get(id).focus).toHaveBeenCalled();
    });

    test.each([
        ['kiroModelCacheTtlMs', ''], ['kiroModelCacheTtlMs', '-1'], ['kiroModelCacheTtlMs', '1.5'],
        ['kiroRefreshAheadMinutes', '0'], ['kiroRefreshAheadMinutes', 'invalid'],
        ['kiroRefreshJitterMs', '-1'], ['kiroRefreshWaitTimeoutMs', '0'],
        ['kiroRefreshWaitTimeoutMs', '2147483648'],
        ['kiroPromptCacheTtlSeconds', ''], ['kiroPromptCacheTtlSeconds', '0'],
        ['kiroPromptCacheTtlSeconds', '-1'], ['kiroPromptCacheTtlSeconds', '3600.001'],
        ['kiroPromptCacheTtlSeconds', '0.0001'], ['kiroPromptCacheTtlSeconds', 'invalid'],
        ['kiroPromptCacheMaxEntries', '0'], ['kiroPromptCacheMaxEntries', '1.5'],
        ['kiroPromptCacheMaxEntries', '1048577']
    ])('blocks an invalid %s value %p before submitting any configuration', async (id, value) => {
        elements.get(id).value = value;
        await saveConfiguration();
        expect(apiClient.post).not.toHaveBeenCalled();
        expect(elements.get(id).focus).toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('common.error', 'config.kiroSettings.invalidNumber', 'error');
    });
});
