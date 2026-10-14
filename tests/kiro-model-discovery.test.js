import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import { service, tick, collect, model, request } from './helpers/kiro-safety-fixtures.js';
import { KiroModelCache } from '../src/providers/claude/kiro-model-cache.js';

describe('opt-in, isolated model capability discovery', () => {
    test('discovery is disabled by default and does not contact upstream', async () => {
        const backend = service(); backend.axiosInstance = { request: jest.fn() };
        expect((await backend.listModels()).models.length).toBeGreaterThan(0); expect(backend.axiosInstance.request).not.toHaveBeenCalled();
    });
    test('TTL caching deduplicates concurrent reads, keeps metadata, and does not expose mutable cache state', async () => {
        const backend = service([], { KIRO_DYNAMIC_MODELS: true });
        backend.axiosInstance = { request: jest.fn(async () => ({ data: { models: [{ modelId: 'new-model', tokenLimits: { maxInputTokens: 1000, maxOutputTokens: 100 } }] } })) };
        const [first, second] = await Promise.all([backend.listModels(), backend.listModels()]);
        expect(backend.axiosInstance.request).toHaveBeenCalledTimes(1); expect(second.models[0].name).toBe('new-model');
        first.models[0].name = 'mutated'; expect((await backend.listModels()).models[0].name).toBe('new-model');
    });
    test.each(['accessToken', 'region', 'profileArn'])('changed %s cannot reuse another identity cache entry', async key => {
        const backend = service([], { KIRO_DYNAMIC_MODELS: true }); backend.axiosInstance = { request: jest.fn(async () => ({ data: { models: [{ modelId: 'x' }] } })) };
        await backend.listModels(); backend[key] = 'changed'; await backend.listModels(); expect(backend.axiosInstance.request).toHaveBeenCalledTimes(2);
    });
    test('pagination loops fail safely to the configured list without changing account health', async () => {
        const backend = service([], { KIRO_DYNAMIC_MODELS: true }); backend.axiosInstance = { request: jest.fn(async () => ({ data: { models: [{ modelId: 'x' }], nextToken: 'same' } })) };
        const result = await backend.listModels(); expect(result.models[0].name).not.toBe('x'); expect(backend.axiosInstance.request).toHaveBeenCalledTimes(2);
    });
    test('a canceled metadata caller does not cancel a concurrent shared read', async () => {
        const backend = service([], { KIRO_DYNAMIC_MODELS: true }); let resolve;
        backend.axiosInstance = { request: jest.fn(() => new Promise(done => { resolve = done; })) };
        const controller = new AbortController(); const first = backend.listModels({ signal: controller.signal }); const second = backend.listModels();
        await tick(); controller.abort(); await expect(first).rejects.toBe(controller.signal.reason);
        resolve({ data: { models: [{ modelId: 'x' }] } }); expect((await second).models[0].name).toBe('x');
        expect(backend.axiosInstance.request).toHaveBeenCalledTimes(1);
    });
    test('discovery cannot advertise an explicitly excluded model', async () => {
        const backend = service([], { KIRO_DYNAMIC_MODELS: true, notSupportedModels: ['blocked'] });
        backend.axiosInstance = { request: jest.fn(async () => ({ data: { models: [{ modelId: 'blocked' }, { modelId: 'allowed' }] } })) };
        expect((await backend.listModels()).models.map(item => item.name)).toEqual(['allowed']);
    });
    test('model discovery exposes only model metadata, not arbitrary upstream fields', async () => {
        const backend = service([], { KIRO_DYNAMIC_MODELS: true });
        backend.axiosInstance = { request: jest.fn(async () => ({ data: { models: [{ modelId: 'x', description: 'model', upstream_secret: 'do not expose' }] } })) };
        const discovered = await backend.listModels();
        expect(discovered.models[0].description).toBe('model'); expect(discovered.models[0].upstream_secret).toBeUndefined();
    });
    test('invalid discovery configuration falls back without failing generation', async () => {
        const backend = service([], { KIRO_DYNAMIC_MODELS: true, KIRO_MODELS_URL: 'http://[invalid' });
        expect((await backend.listModels()).models.length).toBeGreaterThan(0);
    });
    test('a discovered output limit rejects an oversized max_tokens before generation', async () => {
        const backend = service([], { KIRO_DYNAMIC_MODELS: true }); backend.axiosInstance = { request: jest.fn(async () => ({ data: { models: [{ modelId: model, tokenLimits: { maxOutputTokens: 10 } }] } })) };
        await expect(collect(backend.generateContentStream(model, { ...request(), max_tokens: 11 }))).rejects.toMatchObject({ status: 400, skipErrorCount: true });
        expect(backend._requestWithBuilderEndpointRouting).not.toHaveBeenCalled();
    });
    test('pagination keeps the authentication captured by its cache key', async () => {
        const backend = service([], { KIRO_DYNAMIC_MODELS: true });
        backend.axiosInstance = { request: jest.fn(async config => {
            if (!config.url.includes('nextToken')) { backend.accessToken = 'rotated'; return { data: { models: [{ modelId: 'a' }], nextToken: 'next' } }; }
            return { data: { models: [{ modelId: 'b' }] } };
        }) };
        await backend.listModels();
        expect(backend.axiosInstance.request.mock.calls.map(([config]) => config.headers.Authorization)).toEqual(['Bearer mock-only', 'Bearer mock-only']);
    });
    test('metadata caches have a bounded entry count and expired entries refresh', async () => {
        const cache = new KiroModelCache(2); const loader = jest.fn(async () => ({ models: [] }));
        for (const key of ['a', 'b', 'c']) await cache.get(key, loader, {}, 0);
        expect(cache.entries.size).toBe(2); await cache.get('c', loader, {}, 0); expect(loader).toHaveBeenCalledTimes(4);
    });
});
