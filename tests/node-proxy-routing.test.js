jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import http from 'node:http';
import axios from 'axios';
import logger from '../src/utils/logger.js';
import requestContext from '../src/utils/context.js';
import { getTLSSidecar } from '../src/utils/tls-sidecar.js';
import {
    configureAxiosProxy, configureTLSSidecar, getGoogleAuthProxyConfig,
    getProxyConfigForProvider, isProxyEnabledForProvider, parseProxyUrl,
    registerWildcardProxyResolver, resolveProxyUrlForProvider,
    clearProxyAgentCache, PROXY_AGENT_CACHE_LIMIT
} from '../src/utils/proxy-utils.js';

const provider = 'claude-kiro-oauth';
const globalConfig = {
    PROXY_URL: 'http://127.0.0.1:8000',
    PROXY_ENABLED_PROVIDERS: [provider]
};

afterEach(() => {
    registerWildcardProxyResolver(null);
    const sidecar = getTLSSidecar();
    sidecar.ready = false;
    sidecar.process = null;
    jest.clearAllMocks();
});

describe('per-account proxy precedence', () => {
    test.each(['http://127.0.0.1:8001', 'https://127.0.0.1:8002', 'socks5://127.0.0.1:8003'])
    ('explicit %s works without the global allowlist and overrides bindings', nodeProxy => {
        const binding = jest.fn(() => 'http://127.0.0.1:8004');
        const config = { ...globalConfig, NODE_PROXY_URL: nodeProxy, PROXY_ENABLED_PROVIDERS: [] };
        requestContext.run({ ipNodeProxy: { getProxyUrl: binding } }, () => {
            expect(resolveProxyUrlForProvider(config, provider)).toBe(nodeProxy);
            expect(isProxyEnabledForProvider(config, provider)).toBe(true);
            expect(getProxyConfigForProvider(config, provider)).not.toBeNull();
        });
        expect(binding).not.toHaveBeenCalled();
    });

    test.each([undefined, null, '', '   '])('blank %p preserves global allowlist and prefix matching', value => {
        const config = { ...globalConfig, NODE_PROXY_URL: value };
        expect(resolveProxyUrlForProvider(config, provider)).toBe(globalConfig.PROXY_URL);
        expect(resolveProxyUrlForProvider(config, `${provider}-account`)).toBe(globalConfig.PROXY_URL);
        expect(resolveProxyUrlForProvider(config, 'openai-custom')).toBeNull();
        expect(resolveProxyUrlForProvider({ ...config, PROXY_ENABLED_PROVIDERS: [] }, provider)).toBeNull();
    });

    test('bindings still override global fallback and are resolved once per agent configuration', () => {
        const binding = jest.fn(() => 'http://127.0.0.1:8005');
        requestContext.run({ ipNodeProxy: { getProxyUrl: binding } }, () => {
            const config = { ...globalConfig, uuid: 'account-a' };
            configureAxiosProxy({}, config, provider);
            expect(binding).toHaveBeenCalledTimes(1);
            expect(binding).toHaveBeenCalledWith(provider, 'account-a');
        });
        registerWildcardProxyResolver(binding);
        expect(resolveProxyUrlForProvider({}, provider)).toBe('http://127.0.0.1:8005');
    });

    test('invalid explicit proxies fail before any global or binding fallback', () => {
        const binding = jest.fn(() => globalConfig.PROXY_URL);
        const config = { ...globalConfig, NODE_PROXY_URL: 'ftp://username:secret@127.0.0.1' };
        requestContext.run({ ipNodeProxy: { getProxyUrl: binding } }, () => {
            expect(() => configureAxiosProxy({}, config, provider)).toThrow(expect.objectContaining({
                code: 'INVALID_NODE_PROXY_URL'
            }));
            expect(() => resolveProxyUrlForProvider(config, provider, { forSidecar: true })).toThrow();
        });
        expect(binding).not.toHaveBeenCalled();
    });

    test('Sidecar fallback remains compatible but an explicit node always wins', () => {
        const config = { ...globalConfig, PROXY_ENABLED_PROVIDERS: [], TLS_SIDECAR_PROXY_URL: 'http://127.0.0.1:8006' };
        expect(resolveProxyUrlForProvider(config, provider, { forSidecar: true })).toBe(config.TLS_SIDECAR_PROXY_URL);
        expect(resolveProxyUrlForProvider({ ...config, TLS_SIDECAR_PROXY_URL: '' }, provider, { forSidecar: true }))
            .toBe(globalConfig.PROXY_URL);
        expect(resolveProxyUrlForProvider({ ...config, NODE_PROXY_URL: 'socks5://127.0.0.1:8007' }, provider, { forSidecar: true }))
            .toBe('socks5://127.0.0.1:8007');
    });

    test('logs never include proxy username or password', () => {
        getProxyConfigForProvider({ NODE_PROXY_URL: 'http://private-user:private-password@127.0.0.1:8008' }, provider);
        const messages = JSON.stringify(logger.info.mock.calls);
        expect(messages).not.toContain('private-user');
        expect(messages).not.toContain('private-password');
    });
});

describe('proxy agent cache limit', () => {
    const urlFor = index => `http://127.0.0.1:${30000 + index}`;
    beforeEach(() => clearProxyAgentCache());
    afterAll(() => clearProxyAgentCache());

    test('reuses agents for the same URL and refreshes recency on hit', () => {
        const first = parseProxyUrl(urlFor(0));
        const second = parseProxyUrl(urlFor(1));
        for (let index = 2; index < PROXY_AGENT_CACHE_LIMIT; index++) parseProxyUrl(urlFor(index));
        // Touch the oldest entry, then overflow by one: entry 1 should go instead.
        expect(parseProxyUrl(urlFor(0))).toBe(first);
        parseProxyUrl(urlFor(PROXY_AGENT_CACHE_LIMIT));
        expect(parseProxyUrl(urlFor(0))).toBe(first);
        expect(parseProxyUrl(urlFor(1))).not.toBe(second);
    });

    test('eviction closes only idle sockets so in-flight requests on the old agent finish', async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const proxy = http.createServer(async (_req, res) => {
            if (_req.url.endsWith('/slow')) await gate;
            res.end('ok');
        });
        await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
        const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
        try {
            const evicted = parseProxyUrl(proxyUrl);
            const request = path => axios.get(`http://upstream.invalid${path}`, {
                httpAgent: evicted.httpAgent, proxy: false, timeout: 3000
            });
            await request('/warm'); // leaves one idle keep-alive socket
            const inFlight = request('/slow');
            await new Promise(resolve => setTimeout(resolve, 50));
            for (let index = 0; index < PROXY_AGENT_CACHE_LIMIT; index++) parseProxyUrl(urlFor(index));

            expect(parseProxyUrl(proxyUrl)).not.toBe(evicted);
            expect(Object.values(evicted.httpAgent.freeSockets).flat()).toHaveLength(0);
            release();
            await expect(inFlight).resolves.toMatchObject({ data: 'ok' });
            // A retained reference (e.g. a cached client) still works after eviction.
            await expect(request('/again')).resolves.toMatchObject({ data: 'ok' });
        } finally {
            release();
            clearProxyAgentCache();
            proxy.closeAllConnections();
            await new Promise(resolve => proxy.close(resolve));
        }
    });
});

test('Sidecar receives the node upstream while its local request bypasses inherited proxy agents', () => {
    const sidecar = getTLSSidecar();
    sidecar.ready = true;
    sidecar.process = {};
    sidecar.baseUrl = 'http://127.0.0.1:9090';
    const config = {
        ...globalConfig, NODE_PROXY_URL: 'socks5://127.0.0.1:8009',
        TLS_SIDECAR_ENABLED: true, TLS_SIDECAR_ENABLED_PROVIDERS: [provider]
    };
    const refreshAgent = getGoogleAuthProxyConfig(config, provider).agent;
    const request = { url: '/generate', agent: refreshAgent, httpAgent: refreshAgent };
    configureTLSSidecar(request, config, provider, 'https://upstream.invalid');
    expect(request.url).toBe(sidecar.baseUrl);
    expect(request.headers['X-Target-Url']).toBe('https://upstream.invalid/generate');
    expect(request.headers['X-Proxy-Url']).toBe(config.NODE_PROXY_URL);
    expect(request.agent).toBeInstanceOf(http.Agent);
    expect(request.agent).not.toBe(refreshAgent);
    expect(request.httpAgent).toBe(request.agent);
    expect(request.proxy).toBe(false);
    sidecar.wrapAxiosConfig(request, null);
    expect(request.headers['X-Proxy-Url']).toBeUndefined();
});

test('concurrent accounts use separate real proxy connections; blank nodes use the global proxy', async () => {
    const servers = [];
    const received = [];
    const makeProxy = async name => {
        const server = http.createServer((request, response) => {
            received.push({ name, url: request.url });
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ proxy: name }));
        });
        servers.push(server);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        return `http://127.0.0.1:${server.address().port}`;
    };
    try {
        const [firstProxy, secondProxy, fallbackProxy] = await Promise.all([
            makeProxy('first'), makeProxy('second'), makeProxy('global')
        ]);
        const shared = { ...globalConfig, PROXY_URL: fallbackProxy };
        const call = config => axios.request(configureAxiosProxy({
            method: 'get', url: 'http://upstream.invalid/account', timeout: 3000
        }, config, provider));
        const results = await Promise.all([
            call({ ...shared, uuid: 'a', NODE_PROXY_URL: firstProxy }),
            call({ ...shared, uuid: 'b', NODE_PROXY_URL: secondProxy }),
            call({ ...shared, uuid: 'c', NODE_PROXY_URL: '' })
        ]);
        expect(results.map(result => result.data.proxy)).toEqual(['first', 'second', 'global']);
        expect(received).toHaveLength(3);
        const afterClear = await Promise.all([
            call({ ...shared, uuid: 'a', NODE_PROXY_URL: null }),
            call({ ...shared, uuid: 'b', NODE_PROXY_URL: secondProxy })
        ]);
        expect(afterClear.map(result => result.data.proxy)).toEqual(['global', 'second']);
        expect(shared.PROXY_URL).toBe(fallbackProxy);
    } finally {
        await Promise.all(servers.map(server => new Promise(resolve => {
            server.closeAllConnections();
            server.close(resolve);
        })));
    }
});

test('failed account proxies never retry through a working direct target or global proxy', async () => {
    let directRequests = 0;
    let globalRequests = 0;
    const target = http.createServer((_req, res) => { directRequests++; res.end('direct'); });
    const global = http.createServer((_req, res) => { globalRequests++; res.end('global'); });
    const rejected = http.createServer((_req, res) => { res.writeHead(407); res.end('Proxy authentication required'); });
    const servers = [target, global, rejected];
    const listen = server => new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    try {
        await Promise.all(servers.map(listen));
        const url = `http://127.0.0.1:${target.address().port}/account`;
        // Establish that a mistaken direct fallback really would succeed.
        await axios.get(url, { proxy: false });
        directRequests = 0;
        const shared = { ...globalConfig, PROXY_URL: `http://127.0.0.1:${global.address().port}` };
        for (const nodeProxy of ['http://127.0.0.1:0', `http://127.0.0.1:${rejected.address().port}`]) {
            await expect(axios.request(configureAxiosProxy({ url, timeout: 1000 }, {
                ...shared, NODE_PROXY_URL: nodeProxy
            }, provider))).rejects.toThrow();
        }
        expect(directRequests).toBe(0);
        expect(globalRequests).toBe(0);
    } finally {
        await Promise.all(servers.map(server => new Promise(resolve => {
            server.closeAllConnections();
            server.close(resolve);
        })));
    }
});
