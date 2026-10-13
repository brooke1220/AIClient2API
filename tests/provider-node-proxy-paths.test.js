jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null) }));
jest.mock('../src/auth/oauth-handlers.js', () => ({}));
jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(options => ({ options, request: jest.fn() }))
}));
jest.mock('axios', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('ws', () => ({
    __esModule: true,
    default: Object.assign(jest.fn().mockImplementation(() => {
        const { EventEmitter } = require('node:events');
        const socket = new EventEmitter();
        socket.readyState = 3;
        socket.close = jest.fn();
        process.nextTick(() => socket.emit('close', 1000));
        return socket;
    }), { OPEN: 1, CONNECTING: 0 })
}));

import http from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import axios from 'axios';
import WebSocket from 'ws';
import { OAuth2Client } from 'google-auth-library';
import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';
import { GeminiApiService } from '../src/providers/gemini/gemini-core.js';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { ImagineWebSocketService } from '../src/providers/grok/ws-imagine.js';
import { handleGrokAssetsProxy } from '../src/utils/grok-assets-proxy.js';
import { getProxyConfigForProvider } from '../src/utils/proxy-utils.js';
import { getTLSSidecar } from '../src/utils/tls-sidecar.js';

afterEach(() => {
    const sidecar = getTLSSidecar();
    sidecar.ready = false;
    sidecar.process = null;
    jest.clearAllMocks();
});

test.each([
    ['gemini-antigravity', AntigravityApiService],
    ['gemini-cli-oauth', GeminiApiService]
])('%s retains its node proxy for OAuth refresh with Sidecar enabled', (provider, Service) => {
    const config = {
        NODE_PROXY_URL: 'socks5://127.0.0.1:18080', MODEL_PROVIDER: provider,
        TLS_SIDECAR_ENABLED: true, TLS_SIDECAR_ENABLED_PROVIDERS: [provider]
    };
    const service = new Service(config);
    const expected = getProxyConfigForProvider(config, provider);
    expect(OAuth2Client).toHaveBeenLastCalledWith(expect.objectContaining({
        transporterOptions: { agent: expected.httpsAgent }
    }));
    const sidecar = getTLSSidecar();
    sidecar.ready = true;
    sidecar.process = {};
    sidecar.baseUrl = 'http://127.0.0.1:9090';
    const request = service._applySidecar({ url: 'https://upstream.invalid/generate' });
    expect(request.url).toBe(sidecar.baseUrl);
    expect(request.agent).toBeInstanceOf(http.Agent);
    expect(request.agent).not.toBe(expected.httpsAgent);
    expect(request.headers['X-Proxy-Url']).toBe(config.NODE_PROXY_URL);
    sidecar.ready = false;
    const fallback = service._applySidecar({ url: 'https://upstream.invalid/generate' });
    expect(fallback.agent).toBe(expected.httpsAgent);
});

test('Antigravity model detection uses the same node proxy as generation', async () => {
    const config = { NODE_PROXY_URL: 'http://127.0.0.1:18081', MODEL_PROVIDER: 'gemini-antigravity' };
    const service = new AntigravityApiService(config);
    service.baseURLs = ['https://upstream.invalid'];
    service.authClient.request.mockResolvedValue({ data: { models: { 'gemini-3.8-flash': {} } } });
    await service.fetchAvailableModels();
    expect(service.authClient.request).toHaveBeenCalledWith(expect.objectContaining({
        agent: getProxyConfigForProvider(config, config.MODEL_PROVIDER).httpsAgent
    }));
});

test.each(['social', 'builder-id'])('Kiro %s token refresh uses its explicit account proxy', async authMethod => {
    const config = { NODE_PROXY_URL: 'socks5://127.0.0.1:18082', uuid: 'kiro-account' };
    const service = new KiroApiService(config);
    service.authMethod = authMethod;
    service.clientId = 'test-client';
    service.clientSecret = 'test-secret';
    service.refreshToken = 'test-refresh';
    service.refreshUrl = 'https://refresh.invalid/social';
    service.refreshIDCUrl = 'https://refresh.invalid/idc';
    const request = jest.fn().mockResolvedValue({ data: { accessToken: 'new-token', expiresIn: 3600 } });
    service.axiosInstance = { request };
    service.axiosSocialRefreshInstance = { request };
    service._ensureProfileArn = jest.fn().mockResolvedValue(null);
    await service._doTokenRefresh(jest.fn(), '/unused-test-credentials.json');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
        httpsAgent: getProxyConfigForProvider(config, 'claude-kiro-oauth').httpsAgent,
        proxy: false,
        url: authMethod === 'social' ? service.refreshUrl : service.refreshIDCUrl
    }));
});

test('Grok WebSocket image generation uses the account proxy', async () => {
    const config = { NODE_PROXY_URL: 'socks5://127.0.0.1:18083', uuid: 'grok-account' };
    const service = new ImagineWebSocketService(config);
    const result = await service.stream('test-token', 'test prompt').next();
    expect(result.done).toBe(true);
    expect(WebSocket).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        agent: getProxyConfigForProvider(config, 'grok-web').httpsAgent
    }));
});

test.each([false, true])('Grok asset download resolves its UUID proxy even with explicit SSO = %s', async explicitSso => {
    const node = { uuid: 'grok-account', GROK_COOKIE_TOKEN: 'node-token', NODE_PROXY_URL: 'http://127.0.0.1:18084' };
    const config = { PROXY_URL: 'http://127.0.0.1:18085', PROXY_ENABLED_PROVIDERS: ['grok-web'] };
    const response = new PassThrough();
    response.writeHead = jest.fn();
    response.resume();
    axios.mockResolvedValue({ headers: {}, status: 200, data: Readable.from(['image']) });
    await handleGrokAssetsProxy({
        url: `/assets?url=${encodeURIComponent('https://assets.grok.com/test.png')}&uuid=${node.uuid}${explicitSso ? '&sso=explicit-token' : ''}`,
        headers: { host: 'localhost' }
    }, response, config, { findProviderByUuid: jest.fn(() => node) });
    expect(axios).toHaveBeenCalledWith(expect.objectContaining({
        httpsAgent: getProxyConfigForProvider(node, 'grok-web').httpsAgent,
        proxy: false
    }));
    expect(config.NODE_PROXY_URL).toBeUndefined();
});
