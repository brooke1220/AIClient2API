import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/providers/adapter.js', () => ({ invalidateAllServiceAdapters: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ initApiService: jest.fn() }));
jest.mock('../src/ui-modules/auth.js', () => ({ validateCredentials: jest.fn(async () => false) }));
jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
        initialize: jest.fn(), cleanupOldLogs: jest.fn()
    }
}));

import { CONFIG, initializeConfig } from '../src/core/config-manager.js';
import { handleGetConfig, handleUpdateConfig } from '../src/ui-modules/config-api.js';
import * as fileOperations from '../src/utils/file-lock.js';

function response() {
    return {
        writeHead: jest.fn(function (statusCode) { this.statusCode = statusCode; }),
        end: jest.fn(function (body) { this.body = JSON.parse(body); })
    };
}

describe('management configuration persistence', () => {
    let tempDir, configPath, config, originalConfig;
    const settings = {
        KIRO_DYNAMIC_MODELS: true,
        KIRO_MODEL_CACHE_TTL_MS: 120000,
        KIRO_REFRESH_AHEAD_MINUTES: 2.5,
        KIRO_REFRESH_JITTER_MS: 1234,
        KIRO_REFRESH_WAIT_TIMEOUT_MS: 45000
    };
    const readSaved = () => fs.readFile(configPath, 'utf8').then(JSON.parse);

    beforeEach(async () => {
        jest.clearAllMocks();
        originalConfig = { ...CONFIG };
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-config-persistence-'));
        await fs.mkdir(path.join(tempDir, 'configs'));
        configPath = path.join(tempDir, 'configs/config.json');
        const readFile = fs.readFile;
        jest.spyOn(fs, 'readFile').mockImplementation((filePath, ...args) =>
            readFile(filePath === 'configs/config.json' ? configPath : filePath, ...args));
        const atomicWriteFile = fileOperations.atomicWriteFile;
        jest.spyOn(fileOperations, 'atomicWriteFile').mockImplementation((filePath, data, options) =>
            atomicWriteFile(filePath === 'configs/config.json' ? configPath : filePath, data, options));
        config = { MODEL_PROVIDER: 'claude-kiro-oauth', REQUEST_MAX_RETRIES: 3 };
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        for (const key of Object.keys(CONFIG)) delete CONFIG[key];
        Object.assign(CONFIG, originalConfig);
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    async function save(body) {
        const res = response();
        await handleUpdateConfig(Readable.from([Buffer.from(JSON.stringify(body))]), res, config);
        return res;
    }

    test('Kiro settings survive save, page reads and a fresh config load', async () => {
        const res = await save(settings);
        expect(res.statusCode).toBe(200);
        expect(await readSaved()).toMatchObject(settings);
        expect(config).toMatchObject(settings);
        const page = response();
        await handleGetConfig({}, page, config);
        expect(page.body).toMatchObject(settings);
        const reloaded = await initializeConfig([], configPath);
        expect(reloaded).toMatchObject(settings);
    });

    test('disabling discovery and setting zero cache and jitter survive a second save', async () => {
        expect((await save(settings)).statusCode).toBe(200);
        const disabled = { KIRO_DYNAMIC_MODELS: false, KIRO_MODEL_CACHE_TTL_MS: 0, KIRO_REFRESH_JITTER_MS: 0 };
        expect((await save(disabled)).statusCode).toBe(200);
        expect(await readSaved()).toMatchObject({ ...settings, ...disabled });
        const page = response();
        await handleGetConfig({}, page, config);
        expect(page.body).toMatchObject(disabled);
    });

    test('returns usable defaults without exposing provider secrets or runtime state', async () => {
        config.KIRO_OAUTH_CREDS_FILE_PATH = '/private/credentials.json';
        config.providerPools = { private: [{ token: 'secret' }] };
        const page = response();
        await handleGetConfig({}, page, config);
        expect(page.body).toMatchObject({
            KIRO_DYNAMIC_MODELS: false, KIRO_MODEL_CACHE_TTL_MS: 300000,
            KIRO_REFRESH_AHEAD_MINUTES: 10, KIRO_REFRESH_JITTER_MS: 30000,
            KIRO_REFRESH_WAIT_TIMEOUT_MS: 15000
        });
        expect(page.body).not.toHaveProperty('KIRO_OAUTH_CREDS_FILE_PATH');
        expect(page.body).not.toHaveProperty('providerPools');
    });

    test('preserves original file-only fields while excluding runtime and unapproved request fields', async () => {
        const fileOnly = {
            KIRO_TRIM_HISTORY: true, KIRO_FIRST_EVENT_TIMEOUT_MS: 55000,
            REQUEST_BODY_MAX_BYTES: 20000000, PRIVATE_PROVIDER_TOKEN: 'existing-secret',
            customFeature: { enabled: false, targets: ['a', 'b'] }, MODEL_FALLBACK_ENABLED: false
        };
        await fs.writeFile(configPath, JSON.stringify(fileOnly));
        Object.assign(config, { providerPools: { runtime: [] }, DEFAULT_MODEL_PROVIDERS: ['claude-kiro-oauth'], runtimeOnly: 'temporary' });
        expect((await save({ REQUEST_MAX_RETRIES: 2, customFeature: { enabled: true }, injected: 'ignored' })).statusCode).toBe(200);
        const saved = await readSaved();
        expect(saved).toMatchObject({ ...fileOnly, REQUEST_MAX_RETRIES: 2 });
        for (const field of ['providerPools', 'DEFAULT_MODEL_PROVIDERS', 'runtimeOnly', 'injected']) {
            expect(saved).not.toHaveProperty(field);
        }
    });

    test('preserves disk edits made after loading and does not restore a removed file-only field', async () => {
        config.KIRO_TRIM_HISTORY = false;
        config.REMOVED_OPTION = 'stale-memory';
        await fs.writeFile(configPath, JSON.stringify({ KIRO_TRIM_HISTORY: true, laterOption: { enabled: true } }));
        expect((await save({ REQUEST_MAX_RETRIES: 1 })).statusCode).toBe(200);
        expect(await readSaved()).toMatchObject({ KIRO_TRIM_HISTORY: true, laterOption: { enabled: true } });
        expect(await readSaved()).not.toHaveProperty('REMOVED_OPTION');
    });

    test('persists the existing model fallback switch when explicitly disabled', async () => {
        expect((await save({ MODEL_FALLBACK_ENABLED: false })).statusCode).toBe(200);
        expect(await readSaved()).toHaveProperty('MODEL_FALLBACK_ENABLED', false);
    });

    test('serializes concurrent partial saves without losing either change or file-only settings', async () => {
        await fs.writeFile(configPath, JSON.stringify({ fileOnly: { enabled: true } }));
        const results = await Promise.all([
            save({ KIRO_DYNAMIC_MODELS: true }),
            save({ KIRO_REFRESH_WAIT_TIMEOUT_MS: 25000 })
        ]);
        expect(results.map(res => res.statusCode)).toEqual([200, 200]);
        expect(await readSaved()).toMatchObject({
            fileOnly: { enabled: true }, KIRO_DYNAMIC_MODELS: true, KIRO_REFRESH_WAIT_TIMEOUT_MS: 25000
        });
    });

    test('leaves memory unchanged and does not write when the existing file cannot be read', async () => {
        const readFile = fs.readFile.getMockImplementation();
        fs.readFile.mockImplementation((filePath, ...args) => filePath === 'configs/config.json'
            ? Promise.reject(Object.assign(new Error('Access denied'), { code: 'EACCES' }))
            : readFile(filePath, ...args));
        expect((await save({ REQUEST_MAX_RETRIES: 1 })).statusCode).toBe(500);
        expect(config.REQUEST_MAX_RETRIES).toBe(3);
        expect(fileOperations.atomicWriteFile).not.toHaveBeenCalled();
    });

    test('normalizes boolean and numeric strings for Kiro settings', async () => {
        const strings = Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, String(value)]));
        expect((await save(strings)).statusCode).toBe(200);
        expect(await readSaved()).toMatchObject(settings);
        expect((await save({ KIRO_DYNAMIC_MODELS: 'false' })).statusCode).toBe(200);
        expect(await readSaved()).toHaveProperty('KIRO_DYNAMIC_MODELS', false);
    });

    test.each([
        ['KIRO_DYNAMIC_MODELS', 'invalid'], ['KIRO_DYNAMIC_MODELS', null],
        ['KIRO_MODEL_CACHE_TTL_MS', -1], ['KIRO_MODEL_CACHE_TTL_MS', null],
        ['KIRO_MODEL_CACHE_TTL_MS', ''], ['KIRO_MODEL_CACHE_TTL_MS', 1.5],
        ['KIRO_REFRESH_AHEAD_MINUTES', 0], ['KIRO_REFRESH_AHEAD_MINUTES', -1],
        ['KIRO_REFRESH_AHEAD_MINUTES', 'invalid'], ['KIRO_REFRESH_JITTER_MS', -1],
        ['KIRO_REFRESH_JITTER_MS', true], ['KIRO_REFRESH_JITTER_MS', []],
        ['KIRO_REFRESH_WAIT_TIMEOUT_MS', 0], ['KIRO_REFRESH_WAIT_TIMEOUT_MS', 2147483648]
    ])('rejects invalid %s = %p before updating memory or disk', async (field, value) => {
        const original = { ...config, ...settings };
        Object.assign(config, original);
        await fs.writeFile(configPath, JSON.stringify(original));
        const res = await save({ REQUEST_MAX_RETRIES: 1, [field]: value });
        expect(res.statusCode).toBe(400);
        expect(res.body.error.message).toContain(field);
        expect(config).toEqual(original);
        expect(await readSaved()).toEqual(original);
        expect(fileOperations.atomicWriteFile).not.toHaveBeenCalled();
    });

    test.each(['{broken', 'null', '[]', '42'])('does not overwrite an invalid existing config: %s', async content => {
        await fs.writeFile(configPath, content);
        expect((await save({ REQUEST_MAX_RETRIES: 1 })).statusCode).toBe(500);
        expect(await fs.readFile(configPath, 'utf8')).toBe(content);
        expect(config.REQUEST_MAX_RETRIES).toBe(3);
        expect(fileOperations.atomicWriteFile).not.toHaveBeenCalled();
    });
});
