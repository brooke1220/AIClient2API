import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null) }));

import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { getProviderPoolManager } from '../src/services/service-manager.js';
import { collect, frame, model, request, service, text, tool } from './helpers/kiro-safety-fixtures.js';

const tempDirs = [];
const expiry = '2099-01-01T00:00:00.000Z';
const credentials = account => ({
    accessToken: `${account}-access`, refreshToken: `${account}-refresh`,
    profileArn: `${account}-profile`, region: 'us-east-1', authMethod: 'social', expiresAt: expiry
});

async function tempDir() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-core-review-'));
    tempDirs.push(dir);
    return dir;
}

async function writeCredentials(dir, filename, data) {
    const file = path.join(dir, filename);
    await fs.writeFile(file, JSON.stringify(data));
    return file;
}

function credentialService(dir, config = {}) {
    const backend = new KiroApiService({ KIRO_OAUTH_CREDS_DIR_PATH: dir, ...config });
    backend._ensureProfileArn = jest.fn(async () => {});
    return backend;
}

afterEach(async () => {
    getProviderPoolManager.mockReturnValue(null);
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('Kiro credential account isolation', () => {
    test('two configured token files in one directory retain their own complete credentials', async () => {
        const dir = await tempDir();
        const accountA = credentials('A');
        const accountB = { ...credentials('B'), expiresAt: '2099-01-02T00:00:00.000Z' };
        const fileA = await writeCredentials(dir, 'a.json', accountA);
        const fileB = await writeCredentials(dir, 'b.json', accountB);
        const backendA = credentialService(dir, { KIRO_OAUTH_CREDS_FILE_PATH: fileA });
        const backendB = credentialService(dir, { KIRO_OAUTH_CREDS_FILE_PATH: fileB });

        await Promise.all([backendA.loadCredentials(), backendB.loadCredentials()]);

        expect(backendA).toMatchObject(accountA);
        expect(backendB).toMatchObject(accountB);
    });

    test('IdC registration is matched by clientIdHash and cannot replace token or profile fields', async () => {
        const dir = await tempDir();
        const account = { ...credentials('A'), authMethod: 'builder-id', clientIdHash: 'registration-A' };
        const tokenFile = await writeCredentials(dir, 'token.json', account);
        await writeCredentials(dir, 'registration-A.json', {
            ...credentials('wrong'), clientId: 'client-A', clientSecret: 'secret-A'
        });
        await writeCredentials(dir, 'registration-B.json', { clientId: 'client-B', clientSecret: 'secret-B' });
        const backend = credentialService(dir, { KIRO_OAUTH_CREDS_FILE_PATH: tokenFile });

        await backend.loadCredentials();

        expect(backend).toMatchObject({ ...account, clientId: 'client-A', clientSecret: 'secret-A' });
    });

    test('an embedded IdC client remains authoritative over its companion registration', async () => {
        const dir = await tempDir();
        const account = {
            ...credentials('A'), authMethod: 'builder-id', clientIdHash: 'registration-A',
            clientId: 'embedded-client', clientSecret: 'embedded-secret'
        };
        const tokenFile = await writeCredentials(dir, 'token.json', account);
        await writeCredentials(dir, 'registration-A.json', { clientId: 'other-client', clientSecret: 'other-secret' });
        const backend = credentialService(dir, { KIRO_OAUTH_CREDS_FILE_PATH: tokenFile });

        await backend.loadCredentials();

        expect(backend).toMatchObject(account);
    });

    test('an exported IdC token can resolve its exact registration in the configured cache directory', async () => {
        const tokenDir = await tempDir();
        const cacheDir = await tempDir();
        const tokenFile = await writeCredentials(tokenDir, 'token.json', {
            ...credentials('A'), authMethod: 'builder-id', clientIdHash: 'registration-A'
        });
        await writeCredentials(cacheDir, 'registration-A.json', { clientId: 'client-A', clientSecret: 'secret-A' });
        const backend = credentialService(cacheDir, { KIRO_OAUTH_CREDS_FILE_PATH: tokenFile });

        await backend.loadCredentials();

        expect(backend).toMatchObject({ accessToken: 'A-access', clientId: 'client-A', clientSecret: 'secret-A' });
    });

    test.each([undefined, '../registration-A'])('missing or invalid clientIdHash %p cannot select sibling client credentials', async clientIdHash => {
        const dir = await tempDir();
        const tokenFile = await writeCredentials(dir, 'token.json', {
            ...credentials('A'), authMethod: 'builder-id', clientIdHash
        });
        await writeCredentials(dir, 'registration-A.json', { clientId: 'unrelated-client', clientSecret: 'unrelated-secret' });
        const backend = credentialService(dir, { KIRO_OAUTH_CREDS_FILE_PATH: tokenFile });

        await backend.loadCredentials();

        expect(backend.clientId).toBeUndefined();
        expect(backend.clientSecret).toBeUndefined();
    });

    test('Base64 wins over an unrelated default token and refresh reloads the rotated credential', async () => {
        const dir = await tempDir();
        const tokenFile = await writeCredentials(dir, 'kiro-auth-token.json', {
            ...credentials('wrong'), clientId: 'unrelated-client', clientSecret: 'unrelated-secret'
        });
        const account = { ...credentials('A'), expiresAt: '2000-01-01T00:00:00.000Z' };
        const backend = credentialService(dir, {
            KIRO_OAUTH_CREDS_BASE64: Buffer.from(JSON.stringify(account)).toString('base64')
        });
        await backend.initialize();
        expect(backend).toMatchObject(account);
        backend._applySidecar = jest.fn();
        backend.axiosSocialRefreshInstance.request = jest.fn(async () => ({
            data: { accessToken: 'A-fresh-access', refreshToken: 'A-rotated-refresh', expiresIn: 3600 }
        }));

        await backend.initializeAuth(true);

        expect(backend.axiosSocialRefreshInstance.request).toHaveBeenCalledWith(expect.objectContaining({
            data: { refreshToken: 'A-refresh' }
        }));
        expect(JSON.parse(await fs.readFile(backend.credsFilePath, 'utf8'))).toMatchObject({
            accessToken: 'A-fresh-access', refreshToken: 'A-rotated-refresh', profileArn: account.profileArn
        });
        expect(JSON.parse(await fs.readFile(backend.credsFilePath, 'utf8')).clientId).toBeUndefined();
        expect(JSON.parse(await fs.readFile(tokenFile, 'utf8')).accessToken).toBe('wrong-access');
        backend.accessToken = 'stale-in-memory';
        backend.refreshToken = 'stale-in-memory';
        await backend.loadCredentials();
        expect(backend.accessToken).toBe('A-fresh-access');
        expect(backend.refreshToken).toBe('A-rotated-refresh');
    });

    test('a failed first Base64 persistence does not replay the consumed refresh token on reload', async () => {
        const dir = await tempDir();
        const account = credentials('A');
        const backend = credentialService(dir, {
            KIRO_OAUTH_CREDS_BASE64: Buffer.from(JSON.stringify(account)).toString('base64')
        });
        await backend.initialize();
        backend._applySidecar = jest.fn();
        backend.axiosSocialRefreshInstance.request = jest.fn(async () => ({
            data: { accessToken: 'fresh-access', refreshToken: 'rotated-refresh', expiresIn: 3600 }
        }));
        backend.saveCredentialsToFile = jest.fn(async () => { throw new Error('persistence failed'); });

        await expect(backend.initializeAuth(true)).rejects.toThrow('persistence failed');
        await backend.loadCredentials();

        expect(backend.accessToken).toBe('fresh-access');
        expect(backend.refreshToken).toBe('rotated-refresh');
    });

    test('two Base64 accounts keep separate rotated caches across reload, restart and UUID changes', async () => {
        const dir = await tempDir();
        const configs = ['A', 'B'].map(account => ({
            uuid: `initial-${account}`,
            KIRO_OAUTH_CREDS_BASE64: Buffer.from(JSON.stringify(credentials(account))).toString('base64')
        }));
        const backends = configs.map(config => credentialService(dir, config));
        await Promise.all(backends.map(backend => backend.initialize()));
        expect(backends[0].credsFilePath).not.toBe(backends[1].credsFilePath);
        for (const [index, backend] of backends.entries()) {
            const account = index === 0 ? 'A' : 'B';
            backend._applySidecar = jest.fn();
            backend.axiosSocialRefreshInstance.request = jest.fn(async () => ({
                data: { accessToken: `${account}-fresh`, refreshToken: `${account}-rotated`, expiresIn: 3600 }
            }));
        }
        await Promise.all(backends.map(backend => backend.initializeAuth(true)));
        await Promise.all(backends.map(backend => backend.loadCredentials()));

        for (const [index, backend] of backends.entries()) {
            const account = index === 0 ? 'A' : 'B';
            expect(backend).toMatchObject({ accessToken: `${account}-fresh`, refreshToken: `${account}-rotated`, profileArn: `${account}-profile` });
            const restarted = credentialService(dir, { ...configs[index], uuid: `new-${account}` });
            await restarted.initialize();
            expect(restarted.credsFilePath).toBe(backend.credsFilePath);
            expect(restarted).toMatchObject({ accessToken: `${account}-fresh`, refreshToken: `${account}-rotated` });
            expect(restarted.isTokenExpired()).toBe(false);
        }
    });

    test('Base64 keeps precedence over an explicit token file without reading or overwriting it', async () => {
        const dir = await tempDir();
        const explicitFile = await writeCredentials(dir, 'explicit.json', credentials('unrelated'));
        const backend = credentialService(dir, {
            KIRO_OAUTH_CREDS_BASE64: Buffer.from(JSON.stringify(credentials('A'))).toString('base64'),
            KIRO_OAUTH_CREDS_FILE_PATH: explicitFile
        });
        await backend.initialize();
        backend._applySidecar = jest.fn();
        backend.axiosSocialRefreshInstance.request = jest.fn(async () => ({
            data: { accessToken: 'A-fresh', refreshToken: 'A-rotated', expiresIn: 3600 }
        }));

        await backend.initializeAuth(true);

        expect(backend.accessToken).toBe('A-fresh');
        expect(backend.credsFilePath).not.toBe(explicitFile);
        expect(JSON.parse(await fs.readFile(explicitFile, 'utf8'))).toEqual(credentials('unrelated'));
    });

    test('failed rotation persistence keeps newer memory credentials ahead of an existing Base64 cache', async () => {
        const dir = await tempDir();
        const backend = credentialService(dir, {
            KIRO_OAUTH_CREDS_BASE64: Buffer.from(JSON.stringify(credentials('A'))).toString('base64')
        });
        await fs.mkdir(path.dirname(backend.credsFilePath), { recursive: true });
        await fs.writeFile(backend.credsFilePath, JSON.stringify({ ...credentials('A'), refreshToken: 'previous-rotated' }));
        await backend.initialize();
        backend._applySidecar = jest.fn();
        backend.axiosSocialRefreshInstance.request = jest.fn(async () => ({
            data: { accessToken: 'newest-access', refreshToken: 'newest-rotated', expiresIn: 3600 }
        }));
        backend.saveCredentialsToFile = jest.fn(async () => { throw new Error('persistence failed'); });

        await expect(backend.initializeAuth(true)).rejects.toThrow('persistence failed');
        await backend.loadCredentials();

        expect(backend.axiosSocialRefreshInstance.request).toHaveBeenCalledWith(expect.objectContaining({
            data: { refreshToken: 'previous-rotated' }
        }));
        expect(backend).toMatchObject({ accessToken: 'newest-access', refreshToken: 'newest-rotated' });
    });
});

describe('Kiro terminal reasons after complete tools', () => {
    const terminalCases = [
        ['END_TURN', 'tool_use'],
        ['MAX_TOKENS', 'max_tokens'],
        ['MODEL_CONTEXT_WINDOW_EXCEEDED', 'max_tokens'],
        ['STOP_SEQUENCE', 'stop_sequence']
    ];
    test.each(['native', 'legacy'])('%s tools preserve upstream limits and request tool execution after normal completion', async format => {
        for (const [stopReason, expected] of terminalCases) {
            const payload = format === 'native'
                ? tool({ name: 'read', toolUseId: 'tool-A', input: { path: 'a.txt' }, stop: true })
                : text('[Called read with args: {"path":"a.txt"}]');
            const body = { ...request(), tools: [{ name: 'read', input_schema: { type: 'object' } }] };
            const frames = [payload, frame('metadataEvent', { stopReason })];
            const events = await collect(service(frames).generateContentStream(model, body));
            expect(events.find(event => event.content_block?.type === 'tool_use')).toBeDefined();
            expect(events.find(event => event.type === 'message_delta').delta.stop_reason).toBe(expected);
            const message = await service(frames).generateContent(model, body);
            expect(message.content).toContainEqual(expect.objectContaining({ type: 'tool_use', name: 'read', input: { path: 'a.txt' } }));
            expect(message.stop_reason).toBe(expected);
        }
    });
});

async function invoke(backend, mode, body = request(), options = {}) {
    if (mode === 'stream') return collect(backend.streamApiReal('', model, body, false, 0, options));
    return backend.callApi('', model, body);
}

describe('Kiro retry configuration', () => {
    test.each(['stream', 'callApi'])('%s honors zero, numeric strings and rejects invalid retry budgets', async mode => {
        for (const [configured, expectedRequests] of [
            [0, 1], ['0', 1], [2, 3], ['2', 3],
            [-1, 4], [1.5, 4], [Infinity, 4], [NaN, 4], ['invalid', 4], [null, 4], ['', 4], [false, 4]
        ]) {
            const error = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
            const backend = service([], { REQUEST_MAX_RETRIES: configured, REQUEST_BASE_DELAY: 1 });
            backend._requestWithBuilderEndpointRouting.mockRejectedValue(error);

            await expect(invoke(backend, mode)).rejects.toBe(error);

            expect(backend._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(expectedRequests);
        }
    });
});

describe('Kiro final availability check', () => {
    test('streaming forwards trusted health recovery options to the final send check', async () => {
        const backend = service();
        const options = { kiroHealthCheck: true, kiroManualRecovery: true, kiroAccountLease: { assertUsable: jest.fn() } };

        await invoke(backend, 'stream', request(), options);

        expect(backend._requestWithBuilderEndpointRouting).toHaveBeenCalledWith(
            expect.any(Object), expect.any(Object), options
        );
    });

    test('an authoritative lease blocks a paused account after its pool UUID changes', async () => {
        const error = Object.assign(new Error('account paused'), { isKiroAccountUnavailable: true });
        const assertProviderAvailable = jest.fn();
        getProviderPoolManager.mockReturnValue({ assertProviderAvailable });
        const backend = service();
        backend.uuid = 'outdated-uuid';
        backend.axiosInstance = { request: jest.fn() };
        const lease = { assertUsable: jest.fn(() => { throw error; }) };

        await expect(KiroApiService.prototype._requestWithBuilderEndpointRouting.call(
            backend, { url: backend.baseUrl }, {}, { kiroAccountLease: lease }
        )).rejects.toBe(error);

        expect(lease.assertUsable).toHaveBeenCalledTimes(1);
        expect(assertProviderAvailable).not.toHaveBeenCalled();
        expect(backend.axiosInstance.request).not.toHaveBeenCalled();
    });

    test('availability is checked after routing and before the outbound generation request', async () => {
        const error = Object.assign(new Error('account paused'), { isKiroAccountUnavailable: true, skipErrorCount: true });
        const order = [];
        const assertProviderAvailable = jest.fn(() => { order.push('availability'); throw error; });
        getProviderPoolManager.mockReturnValue({ assertProviderAvailable });
        const backend = service();
        backend.uuid = 'account-A';
        backend.config.MODEL_PROVIDER = 'claude-kiro-oauth-custom';
        backend._applySidecar.mockImplementation(() => { order.push('transport'); });
        backend.axiosInstance = { request: jest.fn() };

        await expect(KiroApiService.prototype._requestWithBuilderEndpointRouting.call(
            backend, { url: backend.baseUrl }, {}, { kiroHealthCheck: true, kiroManualRecovery: true }
        )).rejects.toBe(error);

        expect(order).toEqual(['transport', 'availability']);
        expect(assertProviderAvailable).toHaveBeenCalledWith('claude-kiro-oauth-custom', 'account-A', {
            allowUnhealthy: true, manualRecovery: true
        });
        expect(backend.axiosInstance.request).not.toHaveBeenCalled();
    });

    test('request payload flags cannot grant a health or manual recovery exception', async () => {
        const assertProviderAvailable = jest.fn();
        getProviderPoolManager.mockReturnValue({ assertProviderAvailable });
        const backend = service();
        backend.axiosInstance = { request: jest.fn(async () => ({ data: {} })) };
        const payloadLease = { assertUsable: jest.fn() };

        await KiroApiService.prototype._requestWithBuilderEndpointRouting.call(backend,
            { url: backend.baseUrl }, { kiroHealthCheck: true, kiroManualRecovery: true, kiroAccountLease: payloadLease });

        expect(payloadLease.assertUsable).not.toHaveBeenCalled();
        expect(assertProviderAvailable).toHaveBeenCalledWith('claude-kiro-oauth', undefined, {
            allowUnhealthy: false, manualRecovery: false
        });
    });

    test.each(['stream', 'callApi'])('%s preserves local account pause errors without retry or credential mutation', async mode => {
        const error = Object.assign(new Error('account paused'), {
            isKiroAccountUnavailable: true, skipErrorCount: true, code: 'ECONNRESET', response: { status: 429 }
        });
        const backend = service([], { REQUEST_MAX_RETRIES: 2 });
        backend._requestWithBuilderEndpointRouting.mockRejectedValue(error);
        backend._markCredentialNeedRefresh = jest.fn();
        backend._markCredentialUnhealthy = jest.fn();
        backend._refreshUuid = jest.fn();

        await expect(invoke(backend, mode)).rejects.toBe(error);

        expect(backend._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
        expect(backend._markCredentialNeedRefresh).not.toHaveBeenCalled();
        expect(backend._markCredentialUnhealthy).not.toHaveBeenCalled();
        expect(backend._refreshUuid).not.toHaveBeenCalled();
        expect(error.shouldSwitchCredential).toBeUndefined();
    });
});
