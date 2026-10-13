jest.mock('../src/utils/common.js', () => ({
    getRequestBody: jest.fn(async req => req.body)
}));
jest.mock('../src/providers/provider-models.js', () => ({
    extractModelIdsFromNativeList: jest.fn(response => response.data.map(model => model.id)),
    getConfiguredSupportedModels: jest.fn(() => []),
    getProviderModels: jest.fn(() => []),
    normalizeModelIds: jest.fn(models => models || []),
    usesManagedModelList: jest.fn(type => type === 'openai-custom')
}));
jest.mock('../src/providers/adapter.js', () => ({
    getRegisteredProviders: jest.fn(() => []),
    getServiceAdapter: jest.fn(),
    invalidateServiceAdapter: jest.fn()
}));
jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    handleAddProvider, handleUpdateProvider, handleGetProviderType, handleGetProviders,
    handleDetectProviderModels, handleDeleteUnhealthyProviders, handleRefreshUnhealthyUuids,
    handleDeleteProvider, handleDisableEnableProvider, handleRefreshProviderUuid
} from '../src/ui-modules/provider-api.js';
import { getServiceAdapter, invalidateServiceAdapter } from '../src/providers/adapter.js';
import { broadcastEvent } from '../src/ui-modules/event-broadcast.js';
import logger from '../src/utils/logger.js';

function response() {
    return {
        writeHead: jest.fn(function (statusCode) { this.statusCode = statusCode; }),
        end: jest.fn(function (body) { this.body = JSON.parse(body); })
    };
}

describe('provider node proxy persistence', () => {
    let tempDir;
    let config;
    const providerType = 'claude-kiro-oauth';
    const nodes = [
        { uuid: 'account-one', customName: 'one', NODE_PROXY_URL: 'http://proxy-one:7890', isHealthy: true, usageCount: 7 },
        { uuid: 'account-two', customName: 'two', NODE_PROXY_URL: 'socks5://proxy-two:1080', isHealthy: false }
    ];
    const readPools = () => fs.readFile(config.PROVIDER_POOLS_FILE_PATH, 'utf8').then(JSON.parse);

    beforeEach(async () => {
        jest.clearAllMocks();
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiclient-node-proxy-'));
        config = { PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider_pools.json'), PROXY_URL: 'http://global-proxy:80' };
        await fs.writeFile(config.PROVIDER_POOLS_FILE_PATH, JSON.stringify({ [providerType]: nodes }));
    });

    afterEach(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

    test('adds a trimmed proxy, hides returned credentials, and omits proxy URLs from events', async () => {
        const res = response();
        const manager = { initializeProviderStatus: jest.fn() };
        await handleAddProvider({ body: { providerType, providerConfig: {
            uuid: 'account-three', NODE_PROXY_URL: '  https://user:****pass@proxy-three:8443  '
        } } }, res, config, manager);

        expect(res.statusCode).toBe(200);
        expect(res.body.provider.NODE_PROXY_URL).toBe('https://[credentials hidden]@proxy-three:8443/');
        const saved = (await readPools())[providerType];
        expect(saved.slice(0, 2)).toEqual(nodes);
        expect(saved[2].NODE_PROXY_URL).toBe('https://user:****pass@proxy-three:8443');
        expect(manager.providerPools[providerType][2].NODE_PROXY_URL).toBe(saved[2].NODE_PROXY_URL);
        expect(broadcastEvent).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(broadcastEvent.mock.calls)).not.toMatch(/NODE_PROXY_URL|proxy-three|\*\*\*\*pass/);
    });

    test('updates only the selected account, persists on read, and invalidates its adapter', async () => {
        const res = response();
        await handleUpdateProvider({ body: { providerConfig: { NODE_PROXY_URL: ' socks5://new-proxy:1081 ', usageCount: 0 } } }, res, config, null, providerType, 'account-one');
        expect(res.statusCode).toBe(200);
        expect(invalidateServiceAdapter).toHaveBeenCalledWith(providerType, 'account-one');
        const saved = (await readPools())[providerType];
        expect(saved[0]).toMatchObject({ NODE_PROXY_URL: 'socks5://new-proxy:1081', usageCount: 7 });
        expect(saved[1]).toEqual(nodes[1]);

        const reread = response();
        await handleGetProviderType({}, reread, config, null, providerType);
        expect(reread.body.providers[0].NODE_PROXY_URL).toBe('socks5://new-proxy:1081');
    });

    test.each(['', '  \n ', null])('explicit clear persists inheritance: %p', async value => {
        const res = response();
        await handleUpdateProvider({ body: { providerConfig: { NODE_PROXY_URL: value } } }, res, config, null, providerType, 'account-one');
        expect(res.statusCode).toBe(200);
        expect((await readPools())[providerType][0].NODE_PROXY_URL).toBeNull();
        expect(config.PROXY_URL).toBe('http://global-proxy:80');
    });

    test('an omitted field preserves an existing proxy and old nodes remain compatible', async () => {
        const res = response();
        await handleUpdateProvider({ body: { providerConfig: { customName: 'renamed' } } }, res, config, null, providerType, 'account-one');
        expect((await readPools())[providerType][0].NODE_PROXY_URL).toBe(nodes[0].NODE_PROXY_URL);
        await handleAddProvider({ body: { providerType, providerConfig: { uuid: 'legacy-node' } } }, response(), config, null);
        expect((await readPools())[providerType][2]).not.toHaveProperty('NODE_PROXY_URL');
    });

    test.each([
        'http://private-user:private-password@proxy-one:7890',
        'http://private-user@proxy-one:7890',
        'socks5://:private-password@proxy-one:1080',
        'https://private%40user:private%3Apassword@proxy-one:8443'
    ])('list and detail hide all URL authentication information: %s', async proxyUrl => {
        await fs.writeFile(config.PROVIDER_POOLS_FILE_PATH, JSON.stringify({ [providerType]: [{ ...nodes[0], NODE_PROXY_URL: proxyUrl }] }));
        const detail = response();
        const list = response();
        await handleGetProviderType({}, detail, config, null, providerType);
        await handleGetProviders({}, list, config, null);
        expect(detail.body.providers[0].NODE_PROXY_URL).toContain('[credentials hidden]@');
        expect(list.body.providers[providerType][0].NODE_PROXY_URL).toBe(detail.body.providers[0].NODE_PROXY_URL);
        expect(JSON.stringify([list.body, detail.body])).not.toMatch(/private-user|private-password|private%40user|private%3Apassword/);
        expect((await readPools())[providerType][0].NODE_PROXY_URL).toBe(proxyUrl);
    });

    test('an unchanged masked value preserves saved credentials when updating other fields', async () => {
        const proxyUrl = 'http://private-user:private-password@proxy-one:7890';
        await fs.writeFile(config.PROVIDER_POOLS_FILE_PATH, JSON.stringify({ [providerType]: [{ ...nodes[0], NODE_PROXY_URL: proxyUrl }] }));
        const detail = response();
        await handleGetProviderType({}, detail, config, null, providerType);
        const res = response();
        await handleUpdateProvider({ body: { providerConfig: { NODE_PROXY_URL: detail.body.providers[0].NODE_PROXY_URL, customName: 'renamed' } } }, res, config, null, providerType, 'account-one');
        expect(res.statusCode).toBe(200);
        expect((await readPools())[providerType][0]).toMatchObject({ NODE_PROXY_URL: proxyUrl, customName: 'renamed' });
        expect(JSON.stringify([res.body, broadcastEvent.mock.calls])).not.toMatch(/private-user|private-password/);
        expect(JSON.stringify(broadcastEvent.mock.calls)).not.toContain('NODE_PROXY_URL');
    });

    test.each(['http://***:***@replacement:8080', 'socks5://user:real****password@replacement:1080'])('replaces credentials including genuine asterisks: %s', async proxyUrl => {
        const res = response();
        await handleUpdateProvider({ body: { providerConfig: { NODE_PROXY_URL: proxyUrl } } }, res, config, null, providerType, 'account-one');
        expect(res.statusCode).toBe(200);
        expect((await readPools())[providerType][0].NODE_PROXY_URL).toBe(proxyUrl);
        expect(res.body.provider.NODE_PROXY_URL).toContain('[credentials hidden]@replacement');
    });

    test.each(['add', 'update'])('%s refuses a partial edit that still contains hidden credentials', async action => {
        const before = await fs.readFile(config.PROVIDER_POOLS_FILE_PATH, 'utf8');
        const req = { body: { providerType, providerConfig: { NODE_PROXY_URL: 'http://[credentials hidden]@replacement:8080/' } } };
        const res = response();
        if (action === 'add') await handleAddProvider(req, res, config, null);
        else await handleUpdateProvider(req, res, config, null, providerType, 'account-one');
        expect(res.statusCode).toBe(400);
        expect(await fs.readFile(config.PROVIDER_POOLS_FILE_PATH, 'utf8')).toBe(before);
    });

    test.each(['delete', 'disable', 'refresh-uuid'])('%s response hides credentials and its event omits the URL', async action => {
        await fs.writeFile(config.PROVIDER_POOLS_FILE_PATH, JSON.stringify({ [providerType]: [{ ...nodes[0], NODE_PROXY_URL: 'http://private-user:private-password@proxy-one:7890' }] }));
        const res = response();
        if (action === 'delete') await handleDeleteProvider({}, res, config, null, providerType, 'account-one');
        else if (action === 'disable') await handleDisableEnableProvider({}, res, config, null, providerType, 'account-one', 'disable');
        else await handleRefreshProviderUuid({}, res, config, null, providerType, 'account-one');
        expect(res.statusCode).toBe(200);
        expect((res.body.provider || res.body.deletedProvider).NODE_PROXY_URL).toBe('http://[credentials hidden]@proxy-one:7890/');
        expect(JSON.stringify([res.body, broadcastEvent.mock.calls])).not.toMatch(/private-user|private-password/);
        expect(JSON.stringify(broadcastEvent.mock.calls)).not.toContain('NODE_PROXY_URL');
    });

    test.each(['add', 'update'])('%s rejects an invalid URL without writing or exposing credentials', async action => {
        const before = await fs.readFile(config.PROVIDER_POOLS_FILE_PATH, 'utf8');
        const req = { body: { providerType, providerConfig: { NODE_PROXY_URL: 'ftp://private-user:private-password@proxy:21' } } };
        const res = response();
        if (action === 'add') await handleAddProvider(req, res, config, null);
        else await handleUpdateProvider(req, res, config, null, providerType, 'account-one');
        expect(res.statusCode).toBe(400);
        expect(res.body.error.code).toBe('INVALID_NODE_PROXY_URL');
        expect(JSON.stringify(res.body)).not.toMatch(/private-user|private-password/);
        expect(await fs.readFile(config.PROVIDER_POOLS_FILE_PATH, 'utf8')).toBe(before);
        expect(invalidateServiceAdapter).not.toHaveBeenCalled();
        expect(broadcastEvent).not.toHaveBeenCalled();
        expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls])).not.toMatch(/private-user|private-password/);
    });

    test('model detection uses the draft proxy and disposes its temporary adapter', async () => {
        getServiceAdapter.mockReturnValue({ listModels: jest.fn(async () => ({ data: [{ id: 'test-model' }] })) });
        const res = response();
        await handleDetectProviderModels({ body: { providerConfig: { NODE_PROXY_URL: ' http://draft-proxy:8080 ' } } }, res, config, null, 'openai-custom', 'draft-account');
        expect(res.statusCode).toBe(200);
        expect(getServiceAdapter).toHaveBeenCalledWith(expect.objectContaining({ NODE_PROXY_URL: 'http://draft-proxy:8080', PROXY_URL: config.PROXY_URL }));
        expect(invalidateServiceAdapter).toHaveBeenCalledTimes(2);
        expect(invalidateServiceAdapter).toHaveBeenLastCalledWith('openai-custom', 'draft-account-detect-models');
    });

    test('model detection rejects invalid draft proxies before creating a client', async () => {
        const res = response();
        await handleDetectProviderModels({ body: { providerConfig: { NODE_PROXY_URL: 'not-a-url' } } }, res, config, null, 'openai-custom', 'draft-account');
        expect(res.statusCode).toBe(400);
        expect(getServiceAdapter).not.toHaveBeenCalled();
    });

    test.each(['omitted', 'masked', 'clear', 'replacement'])('model detection handles an authenticated proxy draft: %s', async action => {
        const proxyUrl = 'http://private-user:private-password@proxy-one:7890';
        await fs.writeFile(config.PROVIDER_POOLS_FILE_PATH, JSON.stringify({ 'openai-custom': [{ uuid: 'account-one', NODE_PROXY_URL: proxyUrl }] }));
        const detail = response();
        await handleGetProviderType({}, detail, config, null, 'openai-custom');
        const draft = action === 'omitted' ? {} : { NODE_PROXY_URL: {
            masked: detail.body.providers[0].NODE_PROXY_URL,
            clear: null,
            replacement: 'socks5://other:real****password@replacement:1080'
        }[action] };
        getServiceAdapter.mockReturnValue({ listModels: jest.fn(async () => ({ data: [{ id: 'test-model' }] })) });
        const res = response();
        await handleDetectProviderModels({ body: { providerConfig: draft } }, res, config, null, 'openai-custom', 'account-one');
        expect(res.statusCode).toBe(200);
        expect(getServiceAdapter).toHaveBeenCalledWith(expect.objectContaining({
            NODE_PROXY_URL: action === 'clear' ? null : action === 'replacement' ? draft.NODE_PROXY_URL : proxyUrl
        }));
        expect(JSON.stringify(res.body)).not.toMatch(/private-user|private-password|real\*\*\*\*password/);
        expect((await readPools())['openai-custom'][0].NODE_PROXY_URL).toBe(proxyUrl);
    });

    test('bulk deletion retires only removed node adapters', async () => {
        await handleDeleteUnhealthyProviders({}, response(), config, null, providerType);
        expect(invalidateServiceAdapter).toHaveBeenCalledTimes(1);
        expect(invalidateServiceAdapter).toHaveBeenCalledWith(providerType, 'account-two');
        expect((await readPools())[providerType]).toEqual([nodes[0]]);
    });

    test('bulk UUID refresh retires both old and replacement identities', async () => {
        const res = response();
        await handleRefreshUnhealthyUuids({}, res, config, null, providerType);
        const newUuid = res.body.refreshedProviders[0].newUuid;
        expect(invalidateServiceAdapter).toHaveBeenCalledTimes(2);
        expect(invalidateServiceAdapter).toHaveBeenCalledWith(providerType, 'account-two');
        expect(invalidateServiceAdapter).toHaveBeenCalledWith(providerType, newUuid);
    });
});
