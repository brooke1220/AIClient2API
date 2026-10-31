import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

export const root = path.resolve(process.cwd());
export const binary = process.env.KIRO_SIDECAR_TEST_BINARY || path.join(root, 'kiro-sidecar', 'target', 'debug', `kiro-sidecar${process.platform === 'win32' ? '.exe' : ''}`);
export async function waitFor(check, timeout = 3000, description = 'Sidecar test condition') {
    const deadline = Date.now() + timeout;
    while (!await check()) {
        if (Date.now() >= deadline) throw new Error(`${description} timed out`);
        await sleep(10);
    }
}
export async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}
export async function freePort() {
    const server = net.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    return port;
}
export async function readBody(response) {
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    return Buffer.concat(chunks);
}
export function localRequest(sidecar, target, { headers = {}, data, end = true, method = 'POST', route = '/stream' } = {}) {
    const payload = data ?? (method === 'POST' ? '{}' : undefined);
    let request;
    const response = new Promise((resolve, reject) => {
        request = http.request({ hostname: '127.0.0.1', port: sidecar.port, path: route, method, agent: sidecar.agent,
            headers: { 'X-Kiro-Sidecar-Token': sidecar.token, 'X-Kiro-Protocol-Version': '1',
                ...(target ? { 'X-Target-Url': target } : {}), ...headers },
        }, resolve);
        request.on('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error('Local sidecar request timeout')));
        if (end) request.end(payload); else if (payload) request.write(payload);
    });
    response.catch(() => {});
    return { request, response };
}

/** Real TLS upstreams and a CONNECT proxy. No external network is used. */
export async function createFixture() {
    if (!process.env.KIRO_SIDECAR_TEST_BINARY) execFileSync('cargo', ['build', '--locked', '--offline'], { cwd: path.join(root, 'kiro-sidecar'), stdio: 'pipe' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-sidecar-test-'));
    const file = name => path.join(dir, name);
    const openssl = args => execFileSync('openssl', args, { stdio: 'pipe' });
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('ca.key'), '-out', file('ca.pem'), '-days', '1', '-subj', '/CN=Sidecar Test CA']);
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('server.key'), '-out', file('server.csr'), '-subj', '/CN=localhost']);
    fs.writeFileSync(file('extensions'), 'subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    openssl(['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAcreateserial', '-out', file('server.pem'), '-days', '1', '-extfile', file('extensions')]);
    const tls = { key: fs.readFileSync(file('server.key')), cert: fs.readFileSync(file('server.pem')) };
    const sockets = new Set(), sessions = new Set(), children = new Set();
    const fixture = { caFile: file('ca.pem'), ca: fs.readFileSync(file('ca.pem')), requests: [], connects: [],
        handler: (_req, res) => res.end('ok'), proxyAuth: true };
    const handle = (req, res) => {
        const chunks = [];
        req.on('error', () => {});
        res.on('error', () => {});
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            fixture.requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks), version: req.httpVersion });
            fixture.handler(req, res);
        });
    };
    const upstream = http2.createSecureServer({ ...tls, allowHTTP1: true }, handle);
    upstream.on('session', session => { sessions.add(session); session.on('error', () => {}); });
    upstream.on('stream', stream => stream.on('error', () => {}));
    const http1 = https.createServer(tls, handle);
    const proxy = http.createServer();
    proxy.on('connect', (req, socket, head) => {
        fixture.connects.push(req.headers);
        if (!fixture.proxyAuth) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); return; }
        const url = new URL(`http://${req.url}`);
        // Constrain the fixture itself to its own upstreams.
        if (url.hostname !== 'localhost' || ![String(fixture.port), String(fixture.http1Port)].includes(url.port)) { socket.destroy(); return; }
        const tunnel = net.connect(Number(url.port), '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) tunnel.write(head);
            tunnel.pipe(socket); socket.pipe(tunnel);
        });
        sockets.add(tunnel);
        tunnel.on('error', () => socket.destroy());
        socket.on('error', () => tunnel.destroy());
        socket.on('close', () => tunnel.destroy());
    });
    for (const server of [upstream, http1, proxy]) server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); });
    fixture.port = await listen(upstream);
    fixture.http1Port = await listen(http1);
    fixture.proxyPort = await listen(proxy);
    fixture.url = `https://localhost:${fixture.port}`;
    fixture.http1Url = `https://localhost:${fixture.http1Port}`;
    fixture.start = async (extraEnv = {}) => {
        const port = await freePort();
        const token = 'test-local-token';
        const child = spawn(binary, [], { env: { ...process.env,
            SSL_CERT_FILE: fixture.caFile, KIRO_SIDECAR_PORT: String(port), KIRO_SIDECAR_TOKEN: token,
            KIRO_SIDECAR_INSTANCE_ID: 'test-instance', KIRO_SIDECAR_MANAGED: '1',
            KIRO_SIDECAR_TARGET_ALLOWLIST: `${fixture.url},${fixture.http1Url}`, ...extraEnv,
        }, stdio: ['pipe', 'pipe', 'pipe'] });
        children.add(child);
        let output = '';
        child.stdout.on('data', chunk => output += chunk);
        child.stderr.on('data', chunk => output += chunk);
        const agent = new http.Agent({ keepAlive: true });
        const sidecar = { child, port, token, agent,
            context: { kind: 'kiro-sidecar', baseUrl: `http://127.0.0.1:${port}`, localToken: token, instanceId: 'test-instance', agent },
            stop: async () => {
                agent.destroy();
                if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
                children.delete(child);
            },
        };
        await waitFor(async () => {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
            try {
                const res = await localRequest(sidecar, null, { method: 'GET', route: '/health', data: undefined }).response;
                await readBody(res); return res.statusCode === 200;
            } catch { return false; }
        });
        return sidecar;
    };
    fixture.close = async () => {
        await Promise.all([...children].map(async child => {
            if (child.exitCode === null && child.signalCode === null) {
                const exited = once(child, 'exit');
                child.kill('SIGKILL');
                await exited;
            }
        }));
        for (const session of sessions) session.destroy();
        for (const socket of sockets) socket.destroy();
        await Promise.all([upstream, http1, proxy].map(server => new Promise(resolve => server.close(resolve))));
        fs.rmSync(dir, { recursive: true, force: true });
    };
    return fixture;
}
