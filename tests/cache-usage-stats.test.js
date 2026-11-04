import { jest } from '@jest/globals';
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    const legacy = { requestCount: 2, promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 40 };
    const isStore = value => String(value).endsWith('/model-usage-stats.json');
    return { ...actual,
        existsSync: value => isStore(value) || actual.existsSync(value),
        readFileSync: (value, ...args) => isStore(value) ? JSON.stringify({ summary: legacy,
            providers: { kiro: { summary: legacy, models: { sonnet: legacy } } }, daily: { '2026-11-02': legacy } })
            : actual.readFileSync(value, ...args)
    };
});
jest.mock('../src/utils/file-lock.js', () => ({ atomicWriteFile: jest.fn(async () => {}), atomicWriteFileSync: jest.fn() }));
jest.mock('../src/plugins/api-potluck/key-manager.js', () => ({ incrementUsage: jest.fn(async () => {}), KEY_PREFIX: 'test_' }));
jest.mock('../src/plugins/api-potluck/api-routes.js', () => ({}));
import { atomicWriteFile, atomicWriteFileSync } from '../src/utils/file-lock.js';
import { getStats, recordStreamChunkUsage, recordUnaryUsage, finalizeRequest, resetStats, resetTokenStats } from '../src/plugins/model-usage-stats/stats-manager.js';
import potluck from '../src/plugins/api-potluck/index.js';
import { incrementUsage } from '../src/plugins/api-potluck/key-manager.js';
import { attachKiroUsageDetails } from '../src/providers/claude/kiro-cache-usage.js';

const meta = { requestId: 'estimated-stream', provider: 'kiro', model: 'sonnet' };
const final = () => ({ type: 'message_delta', usage: attachKiroUsageDetails({ input_tokens: 2000, output_tokens: 6,
    cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 }, { stage: 'final',
    sources: { cache_read_input_tokens: 'estimated', cache_creation_input_tokens: 'estimated' } }) });

test('migration, final snapshots, persistence, duplicate finalize and resets preserve consistent cache statistics', async () => {
    const migrated = await getStats();
    expect(migrated).toMatchObject({ schemaVersion: 2, summary: { requestCount: 2, cachedTokens: 40,
        cacheCreationTokens: 0, cacheUnavailableRequests: 2 } });
    expect(migrated.providers.kiro.models.sonnet.cacheUnavailableRequests).toBe(2);
    expect(migrated.daily['2026-11-02'].cacheCreationTokens).toBe(0);
    expect(JSON.parse(atomicWriteFileSync.mock.calls[0][1]).cacheStatsStartedAt).toBe(migrated.cacheStatsStartedAt);

    recordStreamChunkUsage({ ...meta, nativeChunk: { type: 'message_start', message: { usage: {
        input_tokens: 40000, output_tokens: 0, cache_read_input_tokens: 10000, cache_creation_input_tokens: 5000 } } } });
    recordStreamChunkUsage({ ...meta, nativeChunk: final(), clientChunk: { usage: { prompt_tokens: 12000, completion_tokens: 6,
        total_tokens: 12006, prompt_tokens_details: { cached_tokens: 8000 } } } });
    recordStreamChunkUsage({ ...meta, nativeChunk: { type: 'message_stop' } });
    expect(await finalizeRequest(meta)).toBe(true);
    expect(await finalizeRequest(meta)).toBe(false);
    const updated = await getStats();
    expect(updated.summary).toMatchObject({ requestCount: 3, promptTokens: 12100, completionTokens: 26,
        totalTokens: 12126, cachedTokens: 8040, cacheCreationTokens: 2000, cacheEstimatedRequests: 1, cacheUnavailableRequests: 2 });
    expect(updated.providers.kiro.models.sonnet.cacheCreationTokens).toBe(2000);
    expect(Object.values(updated.daily).some(day => day.cacheCreationTokens === 2000)).toBe(true);
    expect(JSON.parse(atomicWriteFile.mock.calls.at(-1)[1]).summary).toEqual(expect.objectContaining({ cacheCreationTokens: 2000 }));

    recordUnaryUsage({ ...meta, requestId: 'native', nativeResponse: { type: 'message', usage: {
        input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 } } });
    await finalizeRequest({ ...meta, requestId: 'native' });
    expect((await getStats()).summary).toMatchObject({ requestCount: 4, promptTokens: 12450,
        totalTokens: 12486, cacheCreationTokens: 2100, cacheProviderRequests: 1 });
    const resetTokens = await resetTokenStats();
    expect(resetTokens.summary).toMatchObject({ requestCount: 4, promptTokens: 0, totalTokens: 0,
        cachedTokens: 0, cacheCreationTokens: 0, cacheEstimatedRequests: 0, cacheProviderRequests: 0, cacheUnavailableRequests: 4 });
    expect(resetTokens.providers.kiro.models.sonnet.cacheCreationTokens).toBe(0);
    const resetAll = await resetStats();
    expect(resetAll.summary).toMatchObject({ requestCount: 0, cacheCreationTokens: 0, cacheUnavailableRequests: 0 });
    expect(resetAll.providers).toEqual({});
});

test('Potluck key hooks receive the same final total once without provisional inflation', async () => {
    await potluck.hooks.onStreamChunk({ requestId: 'potluck-stream', nativeChunk: { message: { usage: {
        input_tokens: 40000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 5000, output_tokens: 0 } } } });
    await potluck.hooks.onStreamChunk({ requestId: 'potluck-stream', nativeChunk: final(), chunkToSend: { usage: {
        prompt_tokens: 12000, completion_tokens: 6, total_tokens: 12006 } } });
    await potluck.hooks.onContentGenerated({ _monitorRequestId: 'potluck-stream', potluckApiKey: 'test_key', toProvider: 'kiro', model: 'sonnet' });
    expect(incrementUsage).toHaveBeenLastCalledWith('test_key', 'kiro', 'sonnet', expect.objectContaining({
        promptTokens: 12000, completionTokens: 6, totalTokens: 12006, cachedTokens: 8000, cacheCreationTokens: 2000
    }), 'potluck-stream');
    await potluck.hooks.onUnaryResponse({ requestId: 'potluck-unary', nativeResponse: { type: 'message', usage: {
        input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } });
    await potluck.hooks.onContentGenerated({ _monitorRequestId: 'potluck-unary', potluckApiKey: 'test_key', toProvider: 'kiro', model: 'sonnet' });
    expect(incrementUsage).toHaveBeenLastCalledWith('test_key', 'kiro', 'sonnet', expect.objectContaining({
        promptTokens: 130, completionTokens: 2, totalTokens: 132, cachedTokens: 100, cacheCreationTokens: 20
    }), 'potluck-unary');
});
