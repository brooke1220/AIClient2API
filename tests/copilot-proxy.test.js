jest.mock('../src/utils/proxy-utils.js', () => ({
    ...jest.requireActual('../src/utils/proxy-utils.js'),
    configureTLSSidecar: config => config
}));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('@github/copilot-sdk', () => ({ ...jest.requireActual('@github/copilot-sdk'), CopilotClient: jest.fn() }));

import http from 'node:http';
import net from 'node:net';
import { Server } from 'proxy-chain';
import { CopilotClient } from '@github/copilot-sdk';
import { GitHubCopilotApiService, COPILOT_SDK_ROUTE_CAPACITY } from '../src/providers/github/github-copilot-core.js';
import { buildSdkProxyEnv, createSdkProxyBridge } from '../src/utils/sdk-proxy-bridge.js';
import requestContext from '../src/utils/context.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function createClient() {
    return {
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
        forceStop: jest.fn().mockResolvedValue(undefined),
        createSession: jest.fn(),
        deleteSession: jest.fn().mockResolvedValue(undefined),
        rpc: { account: { getQuota: jest.fn().mockResolvedValue({ quotaSnapshots: {} }) } }
    };
}

function proxyGet(proxyUrl, target = 'http://example.invalid/test') {
    const proxy = new URL(proxyUrl);
    return new Promise((resolve, reject) => {
        const request = http.get({ host: proxy.hostname, port: proxy.port, path: target, agent: false }, response => {
            let body = '';
            response.on('data', data => { body += data; });
            response.on('end', () => resolve({ status: response.statusCode, body }));
        });
        request.on('error', reject);
    });
}

describe('Copilot SDK node proxy lifecycle', () => {
    const services = [];
    const proxies = [];
    function service(proxyUrl = 'http://127.0.0.1:1', uuid = 'test') {
        const value = new GitHubCopilotApiService({ uuid, GITHUB_COPILOT_API_KEY: 'test-pat', NODE_PROXY_URL: proxyUrl });
        services.push(value);
        return value;
    }
    async function upstream(label) {
        const proxy = new Server({
            host: '127.0.0.1', port: 0,
            prepareRequestFunction: () => ({ customResponseFunction: () => ({ statusCode: 200, body: label }) })
        });
        await proxy.listen();
        proxies.push(proxy);
        return `http://127.0.0.1:${proxy.port}`;
    }
    beforeEach(() => {
        jest.clearAllMocks();
        CopilotClient.mockImplementation(() => createClient());
    });
    afterEach(async () => {
        await Promise.all(services.splice(0).map(value => value.dispose({ force: true })));
        await Promise.all(proxies.splice(0).map(value => value.close(true)));
    });

    test('isolates two SDK proxy environments and routes each bridge to its own upstream', async () => {
        const hostEnvironment = { ...process.env };
        const first = service(await upstream('first'), 'first');
        const second = service(await upstream('second'), 'second');
        await Promise.all([first.getSdkClient(), second.getSdkClient()]);
        const [firstOptions, secondOptions] = CopilotClient.mock.calls.map(([options]) => options);
        expect(firstOptions.env.HTTPS_PROXY).not.toEqual(secondOptions.env.HTTPS_PROXY);
        expect(new URL(firstOptions.env.HTTPS_PROXY).hostname).toBe('127.0.0.1');
        expect(await Promise.all([proxyGet(firstOptions.env.HTTPS_PROXY), proxyGet(secondOptions.env.HTTPS_PROXY)]))
            .toEqual([{ status: 200, body: 'first' }, { status: 200, body: 'second' }]);
        expect(firstOptions.env).toEqual(expect.objectContaining({
            HTTP_PROXY: firstOptions.env.HTTPS_PROXY,
            ALL_PROXY: firstOptions.env.HTTPS_PROXY,
            http_proxy: firstOptions.env.HTTPS_PROXY,
            https_proxy: firstOptions.env.HTTPS_PROXY,
            all_proxy: firstOptions.env.HTTPS_PROXY,
            NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1'
        }));
        expect(process.env).toEqual(hostEnvironment);
    });

    test('does not override the SDK environment when no proxy is resolved', async () => {
        await service(null).getSdkClient();
        expect(CopilotClient.mock.calls[0][0]).not.toHaveProperty('env');
    });

    test('isolates concurrent IP-bound routes and quota caches for the same account UUID', async () => {
        const firstProxy = await upstream('first');
        const secondProxy = await upstream('second');
        const value = service(null, 'same-account');
        const clients = [];
        CopilotClient.mockImplementation(options => {
            const client = createClient();
            clients.push(client);
            client.createSession.mockImplementation(async () => ({
                sessionId: 'bound-session', disconnect: jest.fn().mockResolvedValue(),
                sendAndWait: async () => ({ data: { content: (await proxyGet(options.env.HTTP_PROXY)).body } })
            }));
            client.rpc.account.getQuota.mockImplementation(async () => ({
                quotaSnapshots: { chat: {
                    entitlementRequests: 100,
                    usedRequests: (await proxyGet(options.env.HTTP_PROXY)).body === 'first' ? 10 : 20,
                    remainingPercentage: 80
                } }
            }));
            return client;
        });
        const bound = (proxyUrl, callback) => requestContext.run({
            ipNodeProxy: { getProxyUrl: (providerType, uuid) => uuid === 'same-account' ? proxyUrl : null }
        }, callback);
        const [first, second, firstQuota, secondQuota] = await Promise.all([
            bound(firstProxy, () => value.generateAutoContent({ messages: [] })),
            bound(secondProxy, () => value.generateAutoContent({ messages: [] })),
            bound(firstProxy, () => value.getQuota()),
            bound(secondProxy, () => value.getQuota())
        ]);
        expect(first.choices[0].message.content).toBe('first');
        expect(second.choices[0].message.content).toBe('second');
        expect(firstQuota.usedRequests).toBe(10);
        expect(secondQuota.usedRequests).toBe(20);
        await bound(firstProxy, () => value.getQuota());
        await bound(secondProxy, () => value.getQuota());
        expect(clients).toHaveLength(2);
        for (const client of clients) expect(client.rpc.account.getQuota).toHaveBeenCalledTimes(1);
        const urls = CopilotClient.mock.calls.map(([options]) => options.env.HTTP_PROXY);
        expect(new Set(urls).size).toBe(2);
        await value.dispose();
        for (const client of clients) expect(client.stop).toHaveBeenCalledTimes(1);
        for (const url of urls) await expect(proxyGet(url)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });

    test('an explicit node proxy keeps one route across different IP-bound contexts', async () => {
        const proxy = await upstream('explicit');
        const value = service(proxy, 'same-account');
        const bound = proxyUrl => requestContext.run({ ipNodeProxy: { getProxyUrl: () => proxyUrl } }, () => value.getSdkClient());
        const [first, second] = await Promise.all([bound('http://127.0.0.1:2'), bound('http://127.0.0.1:3')]);
        expect(first).toBe(second);
        expect(CopilotClient).toHaveBeenCalledTimes(1);
        expect(await proxyGet(CopilotClient.mock.calls[0][0].env.HTTP_PROXY)).toEqual({ status: 200, body: 'explicit' });
    });

    test('retirement waits for a different route and a missing binding never reuses the prior exit', async () => {
        const proxy = await upstream('bound');
        const value = service(null, 'same-account');
        const first = await requestContext.run({ ipNodeProxy: { getProxyUrl: () => proxy } }, () => value.getSdkClient());
        const pendingQuota = deferred();
        const quotaStarted = deferred();
        const second = createClient();
        second.rpc.account.getQuota.mockImplementation(() => { quotaStarted.resolve(); return pendingQuota.promise; });
        CopilotClient.mockReturnValueOnce(second);
        const quota = value.getQuota();
        await quotaStarted.promise;
        expect(CopilotClient.mock.calls[1][0]).not.toHaveProperty('env');
        let disposed = false;
        const closing = value.dispose().then(() => { disposed = true; });
        await new Promise(resolve => setImmediate(resolve));
        expect(first.stop).toHaveBeenCalledTimes(1);
        expect(second.stop).not.toHaveBeenCalled();
        expect(disposed).toBe(false);
        pendingQuota.resolve({ quotaSnapshots: {} });
        await quota;
        await closing;
        expect(second.stop).toHaveBeenCalledTimes(1);
    });

    test('forces child-process transport for proxy isolation when the host defaults to in-process SDK', () => {
        const previous = process.env.COPILOT_SDK_DEFAULT_CONNECTION;
        process.env.COPILOT_SDK_DEFAULT_CONNECTION = 'inprocess';
        try {
            service().createSdkClient(buildSdkProxyEnv('http://127.0.0.1:1234'));
            const options = CopilotClient.mock.calls[0][0];
            expect(options.connection.kind).toBe('stdio');
            const RealCopilotClient = jest.requireActual('@github/copilot-sdk').CopilotClient;
            expect(() => new RealCopilotClient(options)).not.toThrow();
        } finally {
            if (previous === undefined) delete process.env.COPILOT_SDK_DEFAULT_CONNECTION;
            else process.env.COPILOT_SDK_DEFAULT_CONNECTION = previous;
        }
    });

    test('overrides inherited bypass rules in the child environment only', () => {
        const source = { HTTPS_PROXY: 'http://old', NO_PROXY: '*', PATH: '/bin' };
        const env = buildSdkProxyEnv('http://127.0.0.1:1234', source);
        expect(env.PATH).toBe('/bin');
        expect(env.NO_PROXY).not.toBe('*');
        expect(source.HTTPS_PROXY).toBe('http://old');
        expect(source.NO_PROXY).toBe('*');
    });

    test('shares a single concurrent startup and closes its bridge when startup fails', async () => {
        const started = deferred();
        const client = createClient();
        client.start.mockImplementation(async () => { started.resolve(); throw new Error('startup failed'); });
        CopilotClient.mockReturnValue(client);
        const value = service();
        const results = await Promise.allSettled([value.getSdkClient(), value.getSdkClient()]);
        expect(results.every(result => result.status === 'rejected')).toBe(true);
        expect(CopilotClient).toHaveBeenCalledTimes(1);
        expect(client.forceStop).toHaveBeenCalledTimes(1);
        await expect(proxyGet(CopilotClient.mock.calls[0][0].env.HTTP_PROXY)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
        expect(value.sdkClientPromise).toBeNull();
    });

    test('retirement waits for a quota request and rejects new requests including cached quota', async () => {
        const waiting = deferred();
        const started = deferred();
        const client = createClient();
        client.rpc.account.getQuota.mockImplementation(() => { started.resolve(); return waiting.promise; });
        CopilotClient.mockReturnValue(client);
        const value = service();
        const quota = value.getQuota();
        await started.promise;
        const closing = value.dispose();
        await expect(value.getQuota()).rejects.toThrow('retired');
        expect(client.stop).not.toHaveBeenCalled();
        waiting.resolve({ quotaSnapshots: {} });
        await quota;
        await closing;
        expect(client.stop).toHaveBeenCalledTimes(1);
        await expect(proxyGet(CopilotClient.mock.calls[0][0].env.HTTP_PROXY)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });

    test('retirement during startup lets an existing Auto operation complete before stopping', async () => {
        const started = deferred();
        const waiting = deferred();
        const client = createClient();
        const session = { sessionId: 'auto', sendAndWait: jest.fn().mockResolvedValue({ data: { content: 'OK' } }), disconnect: jest.fn().mockResolvedValue() };
        client.start.mockImplementation(() => { started.resolve(); return waiting.promise; });
        client.createSession.mockResolvedValue(session);
        CopilotClient.mockReturnValue(client);
        const value = service();
        const request = value.generateAutoContent({ messages: [] });
        await started.promise;
        const closing = value.dispose();
        expect(client.stop).not.toHaveBeenCalled();
        waiting.resolve();
        await expect(request).resolves.toMatchObject({ choices: [{ message: { content: 'OK' } }] });
        await closing;
        expect(session.disconnect).toHaveBeenCalledTimes(1);
        expect(client.stop).toHaveBeenCalledTimes(1);
    });

    test('stream cancellation drains session cleanup before retirement closes the bridge', async () => {
        const client = createClient();
        const cleanup = deferred();
        const session = {
            sessionId: 'stream', on: jest.fn(() => jest.fn()), send: jest.fn().mockResolvedValue(),
            disconnect: jest.fn(() => cleanup.promise)
        };
        client.createSession.mockResolvedValue(session);
        CopilotClient.mockReturnValue(client);
        const value = service();
        const stream = value.generateAutoContentStream({ messages: [] });
        await stream.next();
        const closing = value.dispose();
        const cancelled = stream.return();
        await new Promise(resolve => setImmediate(resolve));
        expect(client.stop).not.toHaveBeenCalled();
        cleanup.resolve();
        await cancelled;
        await closing;
        expect(client.deleteSession).toHaveBeenCalledWith('stream');
        expect(client.stop).toHaveBeenCalledTimes(1);
    });

    test('forced disposal during startup stops the client and leaves no listening bridge', async () => {
        const started = deferred();
        const waiting = deferred();
        const client = createClient();
        client.start.mockImplementation(() => { started.resolve(); return waiting.promise; });
        client.forceStop.mockImplementation(async () => waiting.reject(new Error('stopped')));
        CopilotClient.mockReturnValue(client);
        const value = service();
        const pending = value.getSdkClient();
        const rejected = expect(pending).rejects.toThrow('stopped');
        await started.promise;
        await value.dispose({ force: true });
        await rejected;
        expect(client.forceStop).toHaveBeenCalledTimes(2);
        await expect(proxyGet(CopilotClient.mock.calls[0][0].env.HTTP_PROXY)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });

    test('forced retirement before async startup finishes repeats cleanup after late startup', async () => {
        const started = deferred();
        const waiting = deferred();
        const client = createClient();
        client.start.mockImplementation(() => { started.resolve(); return waiting.promise; });
        CopilotClient.mockReturnValue(client);
        const value = service();
        const pending = value.getSdkClient();
        const rejected = expect(pending).rejects.toThrow('retired');
        await started.promise;
        const closing = value.dispose({ force: true });
        await new Promise(resolve => setImmediate(resolve));
        expect(client.forceStop).toHaveBeenCalledTimes(1);
        waiting.resolve();
        await closing;
        await rejected;
        expect(client.forceStop).toHaveBeenCalledTimes(2);
    });

    describe('route capacity', () => {
        const routeUrl = index => `http://127.0.0.1:${20000 + index}`;
        const bound = (value, index, callback) => requestContext.run({
            ipNodeProxy: { getProxyUrl: () => routeUrl(index) }
        }, callback);
        function trackClients() {
            const clients = [];
            CopilotClient.mockImplementation(options => {
                const client = createClient();
                client.bridgeUrl = options.env.HTTP_PROXY;
                clients.push(client);
                return client;
            });
            return clients;
        }

        test('evicts the least recently used idle route and closes its process and bridge', async () => {
            const clients = trackClients();
            const value = service(null, 'capacity-account');
            for (const index of [0, 1, 2, 3]) await bound(value, index, () => value.getQuota());
            // Touch route 0 so route 1 becomes the least recently used.
            await bound(value, 0, () => value.getQuota());
            await bound(value, 4, () => value.getQuota());

            expect(clients).toHaveLength(5);
            expect(value.sdkRouteSlots.size).toBe(COPILOT_SDK_ROUTE_CAPACITY);
            expect([...value.sdkRoutes.keys()].sort()).toEqual([0, 2, 3, 4].map(routeUrl).sort());
            expect(clients[1].stop).toHaveBeenCalledTimes(1);
            await expect(proxyGet(clients[1].bridgeUrl)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
            for (const index of [0, 2, 3, 4]) expect(clients[index].stop).not.toHaveBeenCalled();
        });

        test('rejects a new route with a retryable 503 while every slot is busy, without stopping active work', async () => {
            const clients = trackClients();
            const value = service(null, 'busy-account');
            const pending = [];
            const started = [];
            for (const index of [0, 1, 2, 3]) {
                const gate = deferred();
                const entered = deferred();
                pending.push(gate);
                started.push(entered.promise);
                CopilotClient.mockImplementationOnce(options => {
                    const client = createClient();
                    client.bridgeUrl = options.env.HTTP_PROXY;
                    client.rpc.account.getQuota.mockImplementation(() => { entered.resolve(); return gate.promise; });
                    clients.push(client);
                    return client;
                });
            }
            const busy = [0, 1, 2, 3].map(index => bound(value, index, () => value.getQuota()));
            await Promise.all(started);

            await expect(bound(value, 4, () => value.getQuota())).rejects.toMatchObject({
                code: 'COPILOT_SDK_ROUTE_CAPACITY', status: 503, skipErrorCount: true
            });
            expect(clients).toHaveLength(4);
            for (const client of clients) expect(client.stop).not.toHaveBeenCalled();

            for (const gate of pending) gate.resolve({ quotaSnapshots: {} });
            await Promise.all(busy);
            await bound(value, 4, () => value.getQuota());
            expect(clients).toHaveLength(5);
            expect(value.sdkRouteSlots.size).toBe(COPILOT_SDK_ROUTE_CAPACITY);
        });

        test('concurrent requests for the same new route share one eviction', async () => {
            const clients = trackClients();
            const value = service(null, 'race-account');
            for (const index of [0, 1, 2, 3]) await bound(value, index, () => value.getQuota());
            const results = await Promise.allSettled([
                bound(value, 4, () => value.getQuota()),
                bound(value, 4, () => value.getQuota())
            ]);
            expect(results.filter(result => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
            for (const result of results.filter(item => item.status === 'rejected')) {
                expect(result.reason.code).toBe('COPILOT_SDK_ROUTE_CAPACITY');
            }
            expect(clients).toHaveLength(5);
            expect(value.sdkRouteSlots.size).toBe(COPILOT_SDK_ROUTE_CAPACITY);
        });
    });
});

describe('SDK loopback proxy bridge transport', () => {
    const cleanup = [];
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).reverse().map(close => close()));
    });

    async function listen(server) {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        cleanup.push(() => new Promise(resolve => server.close(resolve)));
        return server.address().port;
    }
    async function bridge(upstream) {
        const value = await createSdkProxyBridge(upstream);
        cleanup.push(() => value.close());
        return value;
    }

    test('uses authenticated HTTP upstreams and does not bypass a rejected proxy', async () => {
        let targetCalls = 0;
        const target = http.createServer((request, response) => { targetCalls += 1; response.end('target'); });
        const targetPort = await listen(target);
        const proxy = new Server({
            host: '127.0.0.1', port: 0,
            prepareRequestFunction: ({ username, password }) => ({ requestAuthentication: username !== 'user' || password !== 'secret' })
        });
        await proxy.listen();
        cleanup.push(() => proxy.close(true));
        const valid = await bridge(`http://user:secret@127.0.0.1:${proxy.port}`);
        const rejected = await bridge(`http://user:wrong@127.0.0.1:${proxy.port}`);
        expect(await proxyGet(valid.url, `http://127.0.0.1:${targetPort}/`)).toEqual({ status: 200, body: 'target' });
        expect((await proxyGet(rejected.url, `http://127.0.0.1:${targetPort}/`)).status).toBeGreaterThanOrEqual(400);
        expect(targetCalls).toBe(1);
    });

    test('never falls back to the target when an upstream is unreachable', async () => {
        let calls = 0;
        const target = http.createServer((request, response) => { calls += 1; response.end('direct'); });
        const targetPort = await listen(target);
        const value = await bridge('http://127.0.0.1:1');
        expect((await proxyGet(value.url, `http://127.0.0.1:${targetPort}/`)).status).toBeGreaterThanOrEqual(400);
        expect(calls).toBe(0);
    });

    test('tunnels CONNECT requests through the selected upstream', async () => {
        const target = http.createServer((request, response) => response.end('tunnel target'));
        const targetPort = await listen(target);
        const requests = [];
        const proxy = new Server({ host: '127.0.0.1', port: 0, prepareRequestFunction: request => { requests.push(request); return {}; } });
        await proxy.listen();
        cleanup.push(() => proxy.close(true));
        const value = await bridge(`http://127.0.0.1:${proxy.port}`);
        const result = await new Promise((resolve, reject) => {
            const socket = net.connect(Number(new URL(value.url).port), '127.0.0.1');
            let response = '';
            let connected = false;
            socket.on('connect', () => socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`));
            socket.on('data', data => {
                response += data.toString();
                if (!connected && response.includes('\r\n\r\n')) {
                    connected = true;
                    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
                }
            });
            socket.on('end', () => resolve(response));
            socket.on('error', reject);
        });
        expect(result).toContain('200 Connection Established');
        expect(result).toContain('tunnel target');
        expect(requests).toHaveLength(1);
        expect(requests[0].isHttp).toBe(false);
    });

    test('forwards HTTP through a SOCKS5 upstream', async () => {
        const target = http.createServer((request, response) => response.end('SOCKS target'));
        const targetPort = await listen(target);
        let tunnelCount = 0;
        const sockets = new Set();
        const socks = net.createServer(socket => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            socket.on('error', () => {});
            let stage = 'hello';
            let buffered = Buffer.alloc(0);
            const receive = data => {
                buffered = Buffer.concat([buffered, data]);
                if (stage === 'hello') {
                    if (buffered.length < 2 || buffered.length < 2 + buffered[1]) return;
                    buffered = buffered.subarray(2 + buffered[1]);
                    socket.write(Buffer.from([5, 0]));
                    stage = 'connect';
                }
                if (stage !== 'connect' || buffered.length < 4) return;
                const domain = buffered[3] === 3;
                const size = domain ? 7 + buffered[4] : 10;
                if (buffered.length < size) return;
                const host = domain ? buffered.subarray(5, size - 2).toString() : [...buffered.subarray(4, 8)].join('.');
                const port = buffered.readUInt16BE(size - 2);
                buffered = buffered.subarray(size);
                stage = 'connected';
                socket.removeListener('data', receive);
                tunnelCount += 1;
                const remote = net.connect(port, host, () => {
                    socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                    if (buffered.length) remote.write(buffered);
                    socket.pipe(remote).pipe(socket);
                });
                sockets.add(remote);
                remote.on('close', () => sockets.delete(remote));
                remote.on('error', () => socket.destroy());
                socket.on('close', () => remote.destroy());
            };
            socket.on('data', receive);
        });
        const socksPort = await listen(socks);
        cleanup.push(async () => { for (const socket of sockets) socket.destroy(); });
        const value = await bridge(`socks5://127.0.0.1:${socksPort}`);
        expect(await proxyGet(value.url, `http://127.0.0.1:${targetPort}/`)).toEqual({ status: 200, body: 'SOCKS target' });
        expect(tunnelCount).toBe(1);
    });
});
