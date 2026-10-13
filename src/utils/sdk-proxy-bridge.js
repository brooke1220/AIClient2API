import { Server } from 'proxy-chain';
import { redactProxyUrl } from './node-proxy-config.js';

/** Give the SDK child process its own proxy without changing the host process. */
export function buildSdkProxyEnv(proxyUrl, environment = process.env) {
    const env = { ...environment };
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        env[name] = proxyUrl;
    }
    env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
    return env;
}

/** Adapt authenticated HTTP(S)/SOCKS proxies to the SDK's HTTP proxy support. */
export async function createSdkProxyBridge(upstreamProxyUrl) {
    const server = new Server({
        host: '127.0.0.1',
        port: 0,
        verbose: false,
        prepareRequestFunction: () => ({ upstreamProxyUrl })
    });
    // Request failures are returned to the SDK; never log proxy credentials.
    server.on('error', () => {});
    let closePromise;
    const close = () => {
        if (!closePromise) closePromise = Promise.resolve().then(() => server.close(true));
        return closePromise;
    };
    try {
        await server.listen();
        return {
            url: `http://127.0.0.1:${server.port}`,
            close
        };
    } catch (error) {
        await close().catch(() => {});
        const failure = new Error(`Copilot proxy bridge could not start for ${redactProxyUrl(upstreamProxyUrl)} (${error.code || 'proxy error'}).`);
        failure.code = error.code;
        throw failure;
    }
}
