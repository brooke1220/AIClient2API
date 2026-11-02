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

describe('Kiro Sidecar configuration persistence', () => {
    let tempDir;
    let config;
    let originalConfig;
    const readSaved = () => fs.readFile(path.join(tempDir, 'configs/config.json'), 'utf8').then(JSON.parse);

    beforeEach(async () => {
        jest.clearAllMocks();
        originalConfig = { ...CONFIG };
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-sidecar-config-'));
        await fs.mkdir(path.join(tempDir, 'configs'));
        const atomicWriteFile = fileOperations.atomicWriteFile;
        // Keep real atomic file writes and locking, but isolate the production config path.
        jest.spyOn(fileOperations, 'atomicWriteFile').mockImplementation((filePath, data, options) =>
            atomicWriteFile(path.join(tempDir, filePath), data, options));
        config = {
            KIRO_SIDECAR_ENABLED: false,
            KIRO_SIDECAR_PORT: 9091,
            KIRO_SIDECAR_PATH: '/opt/kiro/kiro-sidecar',
            KIRO_SIDECAR_PROXY_URL: null,
            SYSTEM_PROMPT_FILE_PATH: path.join(tempDir, 'prompt.txt'),
            PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'pools.json')
        };
        await fs.writeFile(config.PROVIDER_POOLS_FILE_PATH, '{}');
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
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        return readSaved();
    }

    test('enabled state, custom port and upstream proxy survive saving, page reads and a fresh config load', async () => {
        const settings = {
            KIRO_SIDECAR_ENABLED: true, KIRO_SIDECAR_PORT: 19091,
            KIRO_SIDECAR_PROXY_URL: 'socks5://127.0.0.1:1080'
        };
        expect(await save(settings)).toMatchObject(settings);
        expect(config).toMatchObject(settings);

        const page = response();
        await handleGetConfig({}, page, config);
        expect(page.body).toMatchObject(settings);
        expect(page.body).not.toHaveProperty('KIRO_SIDECAR_PATH');

        for (const key of Object.keys(CONFIG)) delete CONFIG[key];
        const reloaded = await initializeConfig([], path.join(tempDir, 'configs/config.json'));
        expect(reloaded).toMatchObject({ ...settings, KIRO_SIDECAR_PATH: config.KIRO_SIDECAR_PATH });
        const refreshedPage = response();
        await handleGetConfig({}, refreshedPage, reloaded);
        expect(refreshedPage.body).toMatchObject(settings);
    });

    test('disabling remains saved and is returned to the page', async () => {
        config.KIRO_SIDECAR_ENABLED = true;
        expect(await save({ KIRO_SIDECAR_ENABLED: false })).toMatchObject({ KIRO_SIDECAR_ENABLED: false });
        const page = response();
        await handleGetConfig({}, page, config);
        expect(page.body.KIRO_SIDECAR_ENABLED).toBe(false);
    });

    test('saving unrelated settings preserves existing Kiro settings and the custom binary path', async () => {
        config.KIRO_SIDECAR_ENABLED = true;
        config.KIRO_SIDECAR_PORT = 19091;
        config.KIRO_SIDECAR_PROXY_URL = 'http://127.0.0.1:7890';
        expect(await save({ REQUEST_MAX_RETRIES: 2 })).toMatchObject({
            KIRO_SIDECAR_ENABLED: true, KIRO_SIDECAR_PORT: 19091, KIRO_SIDECAR_PATH: config.KIRO_SIDECAR_PATH,
            KIRO_SIDECAR_PROXY_URL: config.KIRO_SIDECAR_PROXY_URL
        });
    });

    test('trims the upstream proxy and keeps the TLS Sidecar upstream independent', async () => {
        config.TLS_SIDECAR_PROXY_URL = 'http://127.0.0.1:7891';
        expect(await save({ KIRO_SIDECAR_PROXY_URL: '  http://127.0.0.1:7890  ' })).toMatchObject({
            KIRO_SIDECAR_PROXY_URL: 'http://127.0.0.1:7890',
            TLS_SIDECAR_PROXY_URL: config.TLS_SIDECAR_PROXY_URL
        });
    });

    test.each(['', '   ', null])('clearing the upstream proxy with %p is persisted and returned to the page', async value => {
        config.KIRO_SIDECAR_PROXY_URL = 'http://127.0.0.1:7890';
        expect(await save({ KIRO_SIDECAR_PROXY_URL: value })).toMatchObject({ KIRO_SIDECAR_PROXY_URL: null });
        const page = response();
        await handleGetConfig({}, page, config);
        expect(page.body.KIRO_SIDECAR_PROXY_URL).toBeNull();
    });

    test.each([['true', true], ['false', false]])('normalizes boolean string %s', async (value, expected) => {
        expect(await save({ KIRO_SIDECAR_ENABLED: value })).toMatchObject({ KIRO_SIDECAR_ENABLED: expected });
    });

    test('normalizes a port supplied as a numeric string', async () => {
        expect(await save({ KIRO_SIDECAR_PORT: '19091' })).toMatchObject({ KIRO_SIDECAR_PORT: 19091 });
    });

    test.each([0, -1, 65536, 9091.5, 'invalid', null])('keeps the previous port when the incoming port is invalid: %p', async port => {
        expect(await save({ KIRO_SIDECAR_PORT: port })).toMatchObject({ KIRO_SIDECAR_PORT: 9091 });
    });
});
