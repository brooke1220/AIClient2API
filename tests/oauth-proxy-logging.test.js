jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.mock('../src/core/config-manager.js', () => ({
    CONFIG: {
        PROXY_URL: 'http://global-user:global-password@global-proxy.invalid:8080',
        PROXY_ENABLED_PROVIDERS: ['claude-kiro-oauth', 'openai-qwen-oauth', 'openai-iflow']
    }
}));
jest.mock('../src/services/ui-manager.js', () => ({ broadcastEvent: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ autoLinkProviderConfigs: jest.fn() }));
jest.mock('axios', () => ({ __esModule: true, default: jest.fn() }));

import axios from 'axios';
import logger from '../src/utils/logger.js';
import { CONFIG } from '../src/core/config-manager.js';
import requestContext from '../src/utils/context.js';
import { parseProxyUrl } from '../src/utils/proxy-utils.js';
import { handleKiroOAuth } from '../src/auth/kiro-oauth.js';
import { handleQwenOAuth } from '../src/auth/qwen-oauth.js';
import { refreshIFlowTokens } from '../src/auth/iflow-oauth.js';

const draft = { NODE_PROXY_URL: 'http://draft-proxy.invalid:9090' };
const flows = [
    ['Kiro registration', () => handleKiroOAuth(draft, { method: 'builder-id' })],
    ['Qwen device authorization', () => handleQwenOAuth(draft)],
    ['iFlow token request', () => refreshIFlowTokens('test-refresh-token')]
];

beforeEach(() => {
    jest.clearAllMocks();
    // Stop before opening a browser, polling or persisting any credentials.
    axios.mockResolvedValue({ status: 400, statusText: 'Stopped by test', headers: {}, data: {} });
});

test.each(flows)('%s logs its selected proxy once without credentials or the unused global address', async (_name, start) => {
    const boundUrl = 'http://bound-user:bound-password@bound-proxy.invalid:8081';
    const binding = jest.fn(() => boundUrl);
    await requestContext.run({ ipNodeProxy: { getProxyUrl: binding } }, async () => {
        await expect(start()).rejects.toThrow();
    });
    expect(binding).toHaveBeenCalledTimes(1);
    expect(axios).toHaveBeenCalledTimes(1);
    expect(axios).toHaveBeenCalledWith(expect.objectContaining({
        httpAgent: parseProxyUrl(boundUrl).httpAgent,
        httpsAgent: parseProxyUrl(boundUrl).httpsAgent,
        proxy: false
    }));
    const logs = JSON.stringify(logger.info.mock.calls);
    expect(logs.match(/bound-proxy\.invalid/g)).toHaveLength(1);
    for (const secret of ['bound-user', 'bound-password', 'global-proxy', 'global-user', 'global-password']) {
        expect(logs).not.toContain(secret);
    }
});

test.each(flows)('%s retains the existing global proxy when there is no IP binding', async (_name, start) => {
    await expect(start()).rejects.toThrow();
    expect(axios).toHaveBeenCalledWith(expect.objectContaining({
        httpsAgent: parseProxyUrl(CONFIG.PROXY_URL).httpsAgent,
        proxy: false
    }));
    const logs = JSON.stringify(logger.info.mock.calls);
    expect(logs.match(/global-proxy\.invalid/g)).toHaveLength(1);
    expect(logs).not.toContain('global-user');
    expect(logs).not.toContain('global-password');
    expect(logs).not.toContain('draft-proxy');
});
