#!/usr/bin/env node
/**
 * Upload and request-gzip probe for the AIClient2API -> Kiro hop.
 *
 * Every request sets an invalid output_config.effort, expecting HTTP 400
 * after body parsing and before generation. Unexpected 2xx stops the probe.
 * Timing that 400 for bodies of several sizes separates upload time (the
 * slope) from fixed overhead (the intercept). A gzip-encoded body that is
 * rejected the same way shows that Kiro decodes Content-Encoding: gzip.
 *
 * Reads one existing account's credentials and never refreshes or writes them.
 * Never prints access tokens or profile ARNs. Stops at once on any 2xx reply.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import https from 'node:https';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { lookup as dnsLookup } from 'node:dns/promises';
import { mergeConfig } from '../utils/config-merge.js';
import { resolveProxyUrlForProvider } from '../utils/proxy-utils.js';
import { sendCurl } from './kiro-upload-curl.mjs';

const INVALID_EFFORT = 'probe-invalid-effort';
const DEFAULT_ENDPOINT = 'https://q.{{region}}.amazonaws.com/generateAssistantResponse';
// Same client headers as the streaming path in src/providers/claude/claude-kiro.js.
const X_AMZ_USER_AGENT = 'aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17593 os/linux lang/rust/1.92.0 m/F app/AmazonQ-For-CLI';
const USER_AGENT = 'aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17593 os/linux lang/rust/1.92.0 md/appVersion-2.10.0 app/AmazonQ-For-CLI';
const MAX_BODY_BYTES = 4000000;
const MIN_TOKEN_LIFETIME_MS = 3 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120000;

const HELP = `Usage: node src/scripts/kiro-upload-probe.mjs [options]

Run from the AIClient2API working directory (/app inside the container).
Requests deliberately contain invalid effort, expecting rejection before generation.
Any unexpected 2xx reply stops the probe immediately.
Upload timing uses Node only; --check-only skips it for compatibility diagnosis.

Options:
  --uuid <prefix>          Pool account to use (default: first enabled, healthy one)
  --pools <file>           Provider pools file (default: configs/provider_pools.json)
  --config <file>          Service config file (default: configs/config.json)
  --creds <file>           Use this credentials file instead of the pools file
  --model <id>             Upstream model id (default: claude-opus-5.5)
  --sizes <list>           Body sizes (default: 1k,450k,900k)
  --rounds <n>             Measurements per variant (default: 3)
  --gap-ms <ms>            Pause between requests (default: 1000)
  --endpoint <url>         Override the upstream URL
  --proxy <url|none>       HTTP(S) or SOCKS5 proxy (default: the account's sidecar proxy setting)
  --gzip <auto|force|off>  auto: time gzip bodies only if Kiro accepts them (default)
  --client <node|curl|both>  Clients used for gzip checks (default: node)
  --check-only             Check every size's plain/gzip pair; skip upload timing
  --json <file>            Also write the result as JSON
  --dry-run                Show settings and body sizes without sending anything
  -h, --help               Show this help`;

function fail(message, code = 1) {
    console.error(`kiro-upload-probe: ${message}`);
    process.exit(code);
}

function parseSize(text) {
    const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(text.trim());
    if (!match) fail(`invalid size "${text}"`);
    // Decimal units throughout: 1k = 1000 bytes, matching kB and MB/s in the output.
    const unit = { '': 1, k: 1000, m: 1000000 }[match[2].toLowerCase()];
    const bytes = Math.round(Number(match[1]) * unit);
    if (bytes < 256 || bytes > MAX_BODY_BYTES) fail(`size "${text}" must be between 256 bytes and 4m`);
    return { label: text.trim().toLowerCase(), bytes };
}

function parseArgs(argv) {
    const opts = {
        pools: 'configs/provider_pools.json', config: 'configs/config.json', uuid: null, creds: null,
        model: 'claude-opus-5.5', sizes: '1k,450k,900k', rounds: 3, gapMs: 1000, endpoint: null,
        proxy: null, gzip: 'auto', client: 'node', checkOnly: false, json: null, dryRun: false
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const next = argv[++i];
            if (next === undefined || next.startsWith('--')) fail(`${arg} needs a value`);
            return next;
        };
        switch (arg) {
            case '--uuid': opts.uuid = value(); break;
            case '--pools': opts.pools = value(); break;
            case '--config': opts.config = value(); break;
            case '--creds': opts.creds = value(); break;
            case '--model': opts.model = value(); break;
            case '--sizes': opts.sizes = value(); break;
            case '--rounds': opts.rounds = Number(value()); break;
            case '--gap-ms': opts.gapMs = Number(value()); break;
            case '--endpoint': opts.endpoint = value(); break;
            case '--proxy': opts.proxy = value(); break;
            case '--gzip': opts.gzip = value(); break;
            case '--client': opts.client = value(); break;
            case '--check-only': opts.checkOnly = true; break;
            case '--json': opts.json = value(); break;
            case '--dry-run': opts.dryRun = true; break;
            case '-h': case '--help': console.log(HELP); process.exit(0);
            default: fail(`unknown option ${arg} (see --help)`);
        }
    }
    if (!Number.isSafeInteger(opts.rounds) || opts.rounds < 1 || opts.rounds > 10) fail('--rounds must be 1-10');
    if (!Number.isFinite(opts.gapMs) || opts.gapMs < 0) fail('--gap-ms must be >= 0');
    if (!['auto', 'force', 'off'].includes(opts.gzip)) fail('--gzip must be auto, force or off');
    if (!['node', 'curl', 'both'].includes(opts.client)) fail('--client must be node, curl or both');
    const seen = new Set();
    opts.sizes = opts.sizes.split(',').filter(Boolean).map(parseSize)
        .filter(size => !seen.has(size.bytes) && seen.add(size.bytes))
        .sort((a, b) => a.bytes - b.bytes);
    if (!opts.sizes.length) fail('--sizes is empty');
    return opts;
}

// ---- account, endpoint and proxy resolution (mirrors the service, read-only) ----

const skip = message => Object.assign(new Error(message), { skip: true });

function readJson(file, label) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        fail(`cannot read ${label} ${file}: ${error.message}`);
    }
}

function readCreds(file) {
    try {
        return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    } catch (error) {
        throw skip(error.code === 'ENOENT' ? `credentials file not found (${file})` : `cannot read credentials (${error.message})`);
    }
}

function loadNodeCreds(node, config) {
    const dir = node.KIRO_OAUTH_CREDS_DIR_PATH || config.KIRO_OAUTH_CREDS_DIR_PATH || path.join(os.homedir(), '.aws', 'sso', 'cache');
    if (node.KIRO_OAUTH_CREDS_BASE64) {
        let embedded;
        try {
            embedded = JSON.parse(Buffer.from(node.KIRO_OAUTH_CREDS_BASE64, 'base64').toString('utf8'));
        } catch {
            throw skip('KIRO_OAUTH_CREDS_BASE64 is not valid JSON');
        }
        // The service keeps refreshed tokens for Base64 accounts in this file.
        const fingerprint = crypto.createHash('sha256').update(node.KIRO_OAUTH_CREDS_BASE64).digest('hex');
        const refreshed = path.join(dir, '.kiro-base64', `${fingerprint}.json`);
        return fs.existsSync(refreshed) ? { ...embedded, ...readCreds(refreshed) } : embedded;
    }
    return readCreds(node.KIRO_OAUTH_CREDS_FILE_PATH || path.join(dir, 'kiro-auth-token.json'));
}

function checkAccount({ label, node, config, creds }) {
    const token = creds.accessToken;
    if (typeof token !== 'string' || !token) throw skip('no accessToken');
    if (node.KIRO_API_KEY || token.startsWith('ksk_')) throw skip('API key accounts use another endpoint; not supported');
    const expiresAt = creds.expiresAt ? Date.parse(creds.expiresAt) : NaN;
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() < MIN_TOKEN_LIFETIME_MS) {
        throw skip(`access token ${expiresAt <= Date.now() ? 'has expired' : 'expires within 3 minutes'}; `
            + 'let the service handle one normal request so it refreshes the token, then rerun');
    }
    return {
        label, node, config, token,
        region: creds.region || creds.idcRegion || 'us-east-1',
        authMethod: creds.authMethod || 'unknown',
        profileArn: typeof creds.profileArn === 'string' && creds.profileArn.trim() ? creds.profileArn : undefined,
        expiresAt
    };
}

function resolveAccount(opts) {
    const config = readJson(opts.config, 'config') || {};
    if (opts.creds) {
        try {
            return checkAccount({ label: path.basename(opts.creds), node: {}, config, creds: readCreds(opts.creds) });
        } catch (error) {
            fail(error.message);
        }
    }
    const pools = readJson(opts.pools, 'pools file');
    if (!pools) fail(`${opts.pools} not found; run from the AIClient2API directory or pass --pools / --creds`);
    const nodes = (Array.isArray(pools['claude-kiro-oauth']) ? pools['claude-kiro-oauth'] : [])
        .filter(node => !node.isDisabled && (!opts.uuid || String(node.uuid || '').startsWith(opts.uuid)))
        .sort((a, b) => Number(b.isHealthy !== false) - Number(a.isHealthy !== false));
    if (!nodes.length) {
        fail(opts.uuid ? `no enabled claude-kiro-oauth account starts with "${opts.uuid}"` : 'no enabled claude-kiro-oauth account in the pools file');
    }
    const skipped = [];
    for (const node of nodes) {
        const label = String(node.uuid || 'unknown').slice(0, 8);
        try {
            const account = checkAccount({ label, node, config, creds: loadNodeCreds(node, config) });
            if (skipped.length) console.log(`Skipped accounts: ${skipped.join('; ')}`);
            return account;
        } catch (error) {
            if (!error.skip) throw error;
            skipped.push(`${label}: ${error.message}`);
        }
    }
    fail(`no usable account. ${skipped.join('; ')}`);
}

function resolveEndpoint(opts, account) {
    const base = (opts.endpoint || account.node.KIRO_BASE_URL || account.config.KIRO_BASE_URL || DEFAULT_ENDPOINT)
        .replace('{{region}}', account.region);
    let url;
    try {
        url = new URL(base);
    } catch {
        fail(`invalid endpoint ${base}`);
    }
    if (url.protocol !== 'https:') fail('the endpoint must use https');
    // Profileless Builder ID requests go to CodeWhisperer, as in kiro-profile.js.
    const builderId = /^builder-?id$/i.test(String(account.authMethod).replace(/[_\s]/g, '-'));
    if (!opts.endpoint && builderId && !account.profileArn && /^q\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname)) {
        return new URL(`https://codewhisperer.${account.region}.amazonaws.com/generateAssistantResponse`);
    }
    return url;
}

export function resolveProxy(opts, account) {
    if (opts.proxy === 'none') return null;
    // Use the same effective account configuration and routing precedence as generation.
    const effectiveConfig = mergeConfig(account.config || {}, account.node || {});
    const value = opts.proxy || resolveProxyUrlForProvider(effectiveConfig, 'claude-kiro-oauth', { forSidecar: 'kiro' });
    if (typeof value !== 'string' || !value.trim()) return null;
    let url;
    try {
        url = new URL(value.trim());
    } catch {
        fail('the proxy URL is invalid; pass --proxy <url> or --proxy none');
    }
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) {
        fail(`${url.protocol.replace(':', '')} proxies are not supported by this probe; use http, https, socks5 or socks5h, or --proxy none`);
    }
    return url;
}

const isSocks = url => url.protocol === 'socks5:' || url.protocol === 'socks5h:';
const proxyPort = url => Number(url.port) || (isSocks(url) ? 1080 : url.protocol === 'https:' ? 443 : 80);
const describeProxy = url => url
    ? `${url.protocol}//${url.hostname}:${proxyPort(url)}${url.username ? ' (with auth)' : ''}`
    : 'none (direct)';

const SOCKS_REPLIES = { 1: 'general failure', 2: 'not allowed by ruleset', 3: 'network unreachable', 4: 'host unreachable',
    5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported' };

// socks5:// resolves the target locally and socks5h:// lets the proxy resolve it, as reqwest does in the sidecar.
async function socksTargetAddress(proxy, host, lookup) {
    if (net.isIPv4(host)) return Buffer.from([1, ...host.split('.').map(Number)]);
    if (net.isIP(host)) throw new Error('IPv6 targets are not supported through the SOCKS proxy');
    if (proxy.protocol === 'socks5:') {
        const { address } = await lookup(host, { family: 4 });
        return Buffer.from([1, ...address.split('.').map(Number)]);
    }
    const name = Buffer.from(host);
    if (name.length > 255) throw new Error('target host name is too long for SOCKS5');
    return Buffer.concat([Buffer.from([3, name.length]), name]);
}

// ---- transport: one keep-alive connection, optionally through an HTTP CONNECT or SOCKS5 proxy ----

const ignoreClosedSocketError = () => {};

export function tunnel(proxy, options, callback, transport = {}) {
    let done = false;
    let raw;
    let secure;
    const signal = options.kiroProbeSignal;
    const onAbort = () => finish(signal.reason || new Error('probe request aborted'));
    const onClosed = () => finish(new Error('proxy connection closed before TLS handshake completed'));
    const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        raw?.off('error', finish);
        raw?.off('end', onClosed);
        raw?.off('close', onClosed);
        raw?.off('data', onData);
        raw?.off(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', onConnect);
        secure?.off('error', finish);
        secure?.off('end', onClosed);
        secure?.off('close', onClosed);
        secure?.off('secureConnect', onSecureConnect);
    };
    const finish = (error, socket) => {
        if (done) return;
        done = true;
        cleanup();
        // A pending connection error may arrive after cancellation destroyed its socket.
        raw?.on('error', ignoreClosedSocketError);
        if (error) {
            secure?.on('error', ignoreClosedSocketError);
            secure?.destroy();
            raw?.destroy();
        }
        callback(error, socket);
    };
    const socks = isSocks(proxy);
    const target = `${options.host}:${options.port || 443}`;
    const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
    if (proxy.username && !socks) {
        const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}`);
    }
    const socksUser = socks && proxy.username ? Buffer.from(decodeURIComponent(proxy.username)) : null;
    const socksPass = Buffer.from(socks && proxy.password ? decodeURIComponent(proxy.password) : '');
    let socksAddress;
    let socksStage = 'method';
    const sendSocksConnect = () => {
        const port = Number(options.port) || 443;
        raw.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress, Buffer.from([port >> 8, port & 255])]));
        socksStage = 'connect';
    };
    const onConnect = () => raw.write(socks
        ? Buffer.from(socksUser ? [5, 2, 0, 2] : [5, 1, 0])
        : `${lines.join('\r\n')}\r\n\r\n`);
    const onSecureConnect = () => finish(null, secure);
    const startTls = remainder => {
        // Preserve bytes read beyond the proxy handshake for the TLS socket.
        if (remainder.length) raw.unshift(remainder);
        try {
            secure = (transport.connectTls || tls.connect)({ socket: raw, servername: options.servername || options.host });
            secure.once('secureConnect', onSecureConnect);
            secure.once('error', finish);
            secure.once('end', onClosed);
            secure.once('close', onClosed);
        } catch (error) { finish(error); }
    };
    let head = Buffer.alloc(0);
    const onHttpData = chunk => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
            if (head.length > 16384) {
                finish(new Error('proxy CONNECT reply too large'));
            }
            return;
        }
        raw.off('data', onData);
        raw.pause();
        const status = Number(head.subarray(0, end).toString('latin1').split(' ')[1]);
        if (status !== 200) {
            finish(new Error(`proxy CONNECT returned ${status || 'an invalid reply'}`));
            return;
        }
        startTls(head.subarray(end + 4));
    };
    // RFC 1928 greeting, optional RFC 1929 username/password, then CONNECT. Replies may arrive split or merged.
    const onSocksData = chunk => {
        head = Buffer.concat([head, chunk]);
        try {
            while (!done) {
                if (socksStage === 'method') {
                    if (head.length < 2) return;
                    const [version, method] = head;
                    head = head.subarray(2);
                    if (version !== 5) throw new Error('the proxy did not answer as SOCKS5');
                    if (method === 0) {
                        sendSocksConnect();
                    } else if (method === 2 && socksUser) {
                        if (socksUser.length > 255 || socksPass.length > 255) throw new Error('SOCKS username or password is too long');
                        raw.write(Buffer.concat([Buffer.from([1, socksUser.length]), socksUser, Buffer.from([socksPass.length]), socksPass]));
                        socksStage = 'auth';
                    } else {
                        throw new Error(method === 0xff ? 'SOCKS proxy accepted none of the offered auth methods'
                            : `SOCKS proxy chose unsupported auth method ${method}`);
                    }
                } else if (socksStage === 'auth') {
                    if (head.length < 2) return;
                    const status = head[1];
                    head = head.subarray(2);
                    if (status !== 0) throw new Error('SOCKS proxy rejected the username/password');
                    sendSocksConnect();
                } else {
                    if (head.length < 5) return;
                    if (head[0] !== 5 || head[1] !== 0) {
                        throw new Error(`SOCKS proxy could not connect to Kiro (${SOCKS_REPLIES[head[1]] || `code ${head[1]}`})`);
                    }
                    const addressLength = head[3] === 1 ? 4 : head[3] === 4 ? 16 : head[3] === 3 ? 1 + head[4] : null;
                    if (addressLength === null) throw new Error('SOCKS proxy sent an invalid reply');
                    const total = 4 + addressLength + 2;
                    if (head.length < total) return;
                    raw.off('data', onData);
                    raw.pause();
                    startTls(head.subarray(total));
                    return;
                }
            }
        } catch (error) { finish(error); }
    };
    const onData = socks ? onSocksData : onHttpData;
    const open = () => {
        try {
            raw = proxy.protocol === 'https:'
                ? (transport.connectTls || tls.connect)({ host: proxy.hostname, port: proxyPort(proxy), servername: proxy.hostname })
                : (transport.connect || net.connect)({ host: proxy.hostname, port: proxyPort(proxy) });
            raw.once('error', finish);
            raw.once('end', onClosed);
            raw.once('close', onClosed);
            raw.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', onConnect);
            raw.on('data', onData);
        } catch (error) { finish(error); }
    };
    if (signal?.aborted) { onAbort(); return; }
    if (socks) {
        // The SOCKS request needs the target address first; a local DNS wait is cancellable too.
        signal?.addEventListener('abort', onAbort, { once: true });
        socksTargetAddress(proxy, options.host, transport.lookup || dnsLookup).then(address => {
            if (done) return;
            socksAddress = address;
            open();
        }, error => finish(new Error(`cannot resolve ${options.host} for the SOCKS proxy: ${error.message}`)));
        return;
    }
    open();
    if (!done) signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
}

export function createAgent(proxy, transport = {}) {
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    if (proxy) agent.createConnection = (options, callback) => { tunnel(proxy, options, callback, transport); };
    return agent;
}

export function send(agent, url, headers, payload, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    return new Promise(resolve => {
        const startedAt = performance.now();
        const controller = new AbortController();
        let req;
        let response;
        let writeMs = null;
        let settled = false;
        const settle = result => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        // A wall-clock deadline also covers DNS, CONNECT, TLS and response bodies.
        const timer = setTimeout(() => {
            const error = Object.assign(new Error(`no reply within ${timeoutMs / 1000}s`), { code: 'ETIMEDOUT' });
            controller.abort(error);
            response?.destroy();
            req?.destroy(error);
            settle({ status: null, ttfbMs: null, writeMs, error });
        }, timeoutMs);
        try {
            req = https.request(url, {
                method: 'POST', agent, headers, signal: controller.signal,
                // Agent connection options retain this signal before a socket is assigned.
                kiroProbeSignal: controller.signal
            }, res => {
                response = res;
                const ttfbMs = performance.now() - startedAt;
                const base = { status: res.statusCode, ttfbMs, writeMs, reusedSocket: req.reusedSocket === true, headers: res.headers };
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    // Generation may have started: drop the connection at once.
                    res.destroy();
                    req.destroy();
                    settle({ ...base, unsafe: true });
                    return;
                }
                const chunks = [];
                let length = 0;
                res.on('data', chunk => {
                    if (length < 8192) {
                        chunks.push(chunk);
                        length += chunk.length;
                    }
                });
                res.on('end', () => settle({ ...base, text: Buffer.concat(chunks).toString('utf8').slice(0, 8192) }));
                res.on('error', error => settle({ ...base, error }));
                res.on('close', () => {
                    if (!settled) settle({ ...base, error: new Error('upstream response closed before completion') });
                });
            });
            req.on('error', error => settle({ status: null, ttfbMs: null, writeMs, error }));
            req.end(payload, () => { writeMs = performance.now() - startedAt; });
        } catch (error) {
            controller.abort(error);
            req?.destroy();
            settle({ status: null, ttfbMs: null, writeMs, error });
        }
    });
}

// ---- request bodies ----

function makeRng(seed) {
    let state = seed >>> 0 || 1;
    return () => {
        state ^= state << 13; state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5; state >>>= 0;
        return state / 4294967296;
    };
}

const VOCAB = ('const let return function await async if else for while the to of and a in is that this file '
    + 'request response error value id name data src/ .js logger.info( ms Kiro tool result status true false '
    + 'null path line test config import from export => === { } ( ) ; . , " : [ ] + - * / grep sed cat node '
    + 'npm git diff commit model token stream event message content history text type input output').split(' ');

function fillerText(rng, length) {
    const parts = [];
    let size = 0;
    while (size < length) {
        const roll = rng();
        let word;
        if (roll < 0.1) {
            // Hex ids and hashes keep the gzip ratio close to real agent traffic.
            word = Math.floor(rng() * 2 ** 32).toString(16).padStart(8, '0') + Math.floor(rng() * 2 ** 32).toString(16).padStart(8, '0');
        } else if (roll < 0.16) {
            word = `\n${'  '.repeat(Math.floor(rng() * 4))}`;
        } else {
            word = VOCAB[Math.floor(rng() * VOCAB.length)];
        }
        parts.push(word);
        size += word.length + 1;
    }
    return parts.join(' ').slice(0, length);
}

export function makeBody(size, index, model, profileArn) {
    const rng = makeRng(0x9e3779b9 + index * 7919);
    const userMessage = content => ({ userInputMessage: { content, modelId: model, origin: 'AI_EDITOR' } });
    const build = history => {
        const body = {
            conversationState: {
                agentTaskType: 'vibe',
                chatTriggerType: 'MANUAL',
                conversationId: crypto.randomUUID(),
                ...(history.length ? { history } : {}),
                currentMessage: userMessage('Reply with OK.')
            }
        };
        if (profileArn) body.profileArn = profileArn;
        // Last field: Kiro has to read and parse the whole body before it can reject it.
        body.additionalModelRequestFields = { output_config: { effort: INVALID_EFFORT } };
        return body;
    };
    const history = [];
    let bytes = Buffer.byteLength(JSON.stringify(build(history)));
    while (bytes < size.bytes) {
        const want = Math.min(9000, Math.max(64, size.bytes - bytes));
        const user = userMessage(fillerText(rng, Math.ceil(want / 2)));
        const assistant = { assistantResponseMessage: { content: fillerText(rng, Math.floor(want / 2)) } };
        bytes += Buffer.byteLength(JSON.stringify(user)) + Buffer.byteLength(JSON.stringify(assistant)) + (history.length ? 2 : 14);
        history.push(user, assistant);
    }
    return prepareBody(build(history), size.label);
}

export function prepareBody(object, label) {
    const json = Buffer.from(JSON.stringify(object));
    const compressed = zlib.gzipSync(json, { level: 6 });
    if (!zlib.gunzipSync(compressed).equals(json)) throw new Error('gzip round-trip verification failed; nothing was sent');
    return {
        label, object, json, compressed, jsonBytes: json.length, gzipBytes: compressed.length,
        jsonSha256: crypto.createHash('sha256').update(json).digest('hex'),
        gzipSha256: crypto.createHash('sha256').update(compressed).digest('hex')
    };
}

export function encode(body, gzip) {
    // The same size uses the exact same JSON, including conversationId, across
    // encodings, clients and rounds. Only Content-Encoding and wire length vary.
    return { json: body.json, payload: gzip ? body.compressed : body.json };
}

export function headersFor(token, payload, gzip) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'amz-sdk-invocation-id': crypto.randomUUID(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
        'x-amz-user-agent': X_AMZ_USER_AGENT,
        'user-agent': USER_AGENT,
        'Content-Length': String(payload.length)
    };
    if (gzip) headers['Content-Encoding'] = 'gzip';
    return headers;
}

// ---- reply classification ----

const sanitize = text => String(text)
    .replace(/arn:aws[a-z-]*:[^\s"',]+/gi, 'arn:...')
    .replace(/Bearer\s+\S+/gi, 'Bearer ...')
    .replace(/[A-Za-z0-9+/=_-]{60,}/g, '...');

export function describeReply(result) {
    if (result.error) return { key: `error:${result.error.code || result.error.message}`, text: sanitize(result.error.code || result.error.message) };
    let type = String(result.headers?.['x-amzn-errortype'] || '').split(':')[0];
    let reason = '';
    let message = result.text || '';
    try {
        const parsed = JSON.parse(result.text);
        reason = parsed.reason || '';
        message = parsed.message || parsed.Message || parsed.__type || result.text;
        if (!type && parsed.__type) type = String(parsed.__type).split('#').at(-1);
    } catch { /* not JSON */ }
    message = sanitize(message).replace(/\s+/g, ' ').trim().slice(0, 240);
    const normalized = message.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'ID');
    return {
        key: `${result.status}|${type}|${reason}|${normalized}`,
        text: [result.status, type, reason].filter(Boolean).join(' ') + (message ? `: ${message}` : ''),
        type, message
    };
}

export function isEffortRejection(sample) {
    if (sample?.status !== 400 || sample.transportError) return false;
    if (!/ValidationException/i.test(sample.replyType || sample.reply || '')) return false;
    const message = sample.replyMessage || sample.reply || '';
    return (/effort/i.test(message) && /invalid|enumeration|allowed|value|must/i.test(message))
        || (/Invalid additionalModelRequestFields/i.test(message) && /enumeration/i.test(message)
            && /["']low["']/.test(message) && /["']medium["']/.test(message) && /["']high["']/.test(message));
}

export function classifyGzipPair(plain, gzip) {
    if (!isEffortRejection(plain)) return { verdict: 'inconclusive', reason: 'plain request did not reach the expected invalid-effort validation' };
    if (!gzip || gzip.transportError || gzip.status == null) return { verdict: 'inconclusive', reason: 'gzip request had no complete upstream reply' };
    if (!plain.jsonSha256 || plain.jsonSha256 !== gzip.jsonSha256) return { verdict: 'inconclusive', reason: 'plain and gzip did not use identical JSON' };
    if (isEffortRejection(gzip)) return { verdict: 'supported', reason: 'gzip reached the expected invalid-effort validation' };
    if ((gzip.status === 400 && /SerializationException|UnsupportedContentEncoding|UnsupportedEncoding/i.test(gzip.replyType || ''))
        || gzip.status === 415) {
        return { verdict: 'rejected', reason: 'gzip was rejected during parsing or content-encoding handling' };
    }
    return { verdict: 'inconclusive', reason: 'gzip returned a different error; this does not establish compression support' };
}

export function summarizeGzipChecks(checks) {
    const verdicts = new Set(checks.map(check => check.verdict));
    const gzipVerdict = !checks.length ? 'not-tested'
        : verdicts.has('supported') && verdicts.has('rejected') ? 'mixed'
            : verdicts.size === 1 ? checks[0].verdict : 'inconclusive';
    const bySize = new Map();
    const byClient = new Map();
    for (const check of checks) {
        if (!bySize.has(check.size)) bySize.set(check.size, new Set());
        if (!byClient.has(check.client)) byClient.set(check.client, new Set());
        bySize.get(check.size).add(check.verdict);
        byClient.get(check.client).add(check.verdict);
    }
    const conflicts = values => values.has('supported') && values.has('rejected');
    const clientDependent = [...bySize.values()].some(conflicts);
    const sizeDependent = [...byClient.values()].some(conflicts);
    const independentAgreement = byClient.size > 1 && ['supported', 'rejected'].includes(gzipVerdict)
        && [...bySize].every(([size, values]) => values.size === 1
            && new Set(checks.filter(check => check.size === size).map(check => check.client)).size === byClient.size);
    return {
        gzipAccepted: gzipVerdict === 'supported' ? true : gzipVerdict === 'rejected' ? false : null,
        gzipVerdict, clientDependent, sizeDependent, independentAgreement
    };
}

// ---- statistics ----

const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function fitLine(points) {
    if (points.length < 3 || new Set(points.map(point => point[0])).size < 2) return null;
    const meanX = points.reduce((sum, point) => sum + point[0], 0) / points.length;
    const meanY = points.reduce((sum, point) => sum + point[1], 0) / points.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of points) {
        sxx += (x - meanX) ** 2;
        sxy += (x - meanX) * (y - meanY);
        syy += (y - meanY) ** 2;
    }
    const slope = sxy / sxx;
    const round = (value, digits) => Number(value.toFixed(digits));
    return {
        msPer100kB: round(slope * 100000, 1), interceptMs: Math.round(meanY - slope * meanX),
        r2: round(syy ? (sxy * sxy) / (sxx * syy) : 1, 3), mbPerSecond: slope > 0 ? round(1 / (slope * 1000), 3) : null
    };
}

const kb = bytes => `${(bytes / 1000).toFixed(1)} kB`;
const ms = value => (value === null || value === undefined ? '-' : `${Math.round(value)} ms`);
const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));

// ---- main ----

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const account = resolveAccount(opts);
    const url = resolveEndpoint(opts, account);
    const proxy = resolveProxy(opts, account);
    const bodies = opts.sizes.map((size, index) => makeBody(size, index, opts.model, account.profileArn));
    const clients = opts.client === 'both' ? ['node', 'curl'] : [opts.client];
    const largest = bodies.at(-1);
    const minutesLeft = Number.isFinite(account.expiresAt) ? `${Math.round((account.expiresAt - Date.now()) / 60000)} min` : 'unknown';

    console.log('Kiro upload probe: invalid effort is intended to reject requests before generation; unexpected 2xx stops all checks.');
    console.log(`  account   ${account.label}  auth=${account.authMethod}  region=${account.region}  token valid for ${minutesLeft}`);
    console.log(`  endpoint  ${url.origin}${url.pathname}`);
    console.log(`  proxy     ${describeProxy(proxy)}`);
    console.log(`  model     ${opts.model}`);
    console.log(`  clients   ${clients.join(', ')} (HTTP/1.1; same proxy and identical JSON per size)`);
    console.log(`  bodies    ${bodies.map(body => `${body.label}=${kb(body.jsonBytes)}`).join(', ')}; `
        + `gzip of the largest: ${kb(largest.gzipBytes)} (${(100 * largest.gzipBytes / largest.jsonBytes).toFixed(0)}%)`);
    for (const body of bodies) console.log(`  verified  ${body.label.padEnd(6)} gzip round-trip OK; JSON sha256 ${body.jsonSha256.slice(0, 16)}`);
    if (opts.dryRun) {
        console.log('Dry run: nothing was sent.');
        return;
    }

    const agent = createAgent(proxy);
    const samples = [];
    const run = async (body, gzip, phase, client = 'node') => {
        if (samples.length) await sleep(opts.gapMs);
        const { json, payload } = encode(body, gzip);
        const headers = headersFor(account.token, payload, gzip);
        const result = client === 'curl'
            ? await sendCurl(url, headers, payload, { proxy })
            : await send(agent, url, headers, payload);
        if (result.unsafe) {
            console.error(`\nKiro returned HTTP ${result.status} for ${gzip ? 'gzip' : 'plain'} ${body.label}: the invalid effort was not rejected.`);
            console.error('The connection was dropped at once to stop generation. Check this account\'s usage before running again.');
            process.exit(2);
        }
        const reply = describeReply(result);
        const sample = {
            phase, client, size: body.label, gzip, jsonBytes: json.length, wireBytes: payload.length, status: result.status,
            jsonSha256: body.jsonSha256, wireSha256: gzip ? body.gzipSha256 : body.jsonSha256,
            ttfbMs: result.ttfbMs, writeMs: result.writeMs, reusedSocket: result.reusedSocket === true,
            replyKey: reply.key, reply: reply.text, replyType: reply.type, replyMessage: reply.message,
            transportError: Boolean(result.error)
        };
        samples.push(sample);
        return sample;
    };
    const line = sample => `${sample.client.padEnd(4)} ${sample.gzip ? 'gzip ' : 'plain'} ${sample.size.padEnd(6)} wire ${kb(sample.wireBytes).padStart(9)}  `
        + `ttfb ${ms(sample.ttfbMs).padStart(8)}  ${sample.reply.slice(0, 160)}${sample.client === 'node' && !sample.reusedSocket ? '  [new connection]' : ''}`;

    const smallest = bodies[0];
    const baseline = await run(smallest, false, 'baseline', clients[0]);
    console.log(`\nBaseline  ${line(baseline)}`);
    if (baseline.status !== 400) {
        fail(`expected HTTP 400 from the invalid effort, got: ${baseline.reply}. Nothing else was sent.`, 3);
    }
    if (!isEffortRejection(baseline)) {
        console.log('  Note: this is not a confirmed invalid-effort rejection; matching errors alone cannot establish gzip support.');
    }

    const checks = [];
    const plainBySize = new Map();
    if (clients[0] === 'node') plainBySize.set(smallest.label, baseline);
    if (opts.gzip !== 'off') {
        console.log('\nGzip checks: plain then gzip for every size and client. A failed small body does not skip larger bodies.');
        for (const client of clients) {
            for (const body of bodies) {
                const plain = client === clients[0] && body === smallest ? baseline
                    : await run(body, false, 'gzip-baseline', client);
                if (plain !== baseline) console.log(`Plain     ${line(plain)}`);
                if (client === 'node') plainBySize.set(body.label, plain);
                const compressed = isEffortRejection(plain) ? await run(body, true, 'gzip-check', client) : null;
                if (compressed) console.log(`Gzip      ${line(compressed)}`);
                const assessment = classifyGzipPair(plain, compressed);
                checks.push({
                    client, size: body.label, jsonSha256: body.jsonSha256, ...assessment,
                    plain: plain.reply, gzip: compressed?.reply ?? null
                });
                console.log(`  => ${client} ${body.label}: ${assessment.verdict.toUpperCase()} (${assessment.reason})`);
            }
        }
    }

    const assessment = summarizeGzipChecks(checks);
    console.log(`\nGzip verdict: ${assessment.gzipVerdict.toUpperCase()} (this endpoint and request format only)`);
    if (assessment.clientDependent) console.log('  Node and curl disagree for the same size; the failure cannot be attributed to Kiro alone.');
    if (assessment.sizeDependent) console.log('  Support differs by body size; do not apply the small-body result to all sizes.');
    if (assessment.independentAgreement) console.log('  Node and curl independently agree for every tested size.');
    if (assessment.gzipVerdict === 'inconclusive') console.log('  Inconclusive replies do not establish whether request gzip is supported.');

    const finish = (fit, summary) => {
        const result = {
            probe: 'kiro-upload', at: new Date().toISOString(), account: account.label, authMethod: account.authMethod, region: account.region,
            endpoint: `${url.origin}${url.pathname}`, proxy: describeProxy(proxy), model: opts.model, clients,
            ...assessment, checks, baseline: baseline.reply, fit, summary,
            samples: samples.map(({ replyKey, ...sample }) => ({
                ...sample, ttfbMs: sample.ttfbMs == null ? null : Math.round(sample.ttfbMs),
                writeMs: sample.writeMs == null ? null : Math.round(sample.writeMs)
            }))
        };
        if (opts.json) {
            fs.writeFileSync(opts.json, `${JSON.stringify(result, null, 2)}\n`);
            console.log(`Wrote ${opts.json}`);
        }
        console.log(`\nRESULT ${JSON.stringify({ ...assessment, checks, fit, summary, proxy: result.proxy, endpoint: result.endpoint, baseline: result.baseline })}`);
        agent.destroy();
    };
    if (opts.checkOnly) {
        finish(null, []);
        return;
    }

    // curl is an independent compatibility check, not a sample for Node's
    // connection-reuse or bandwidth fit. Never mix the clients' timings.
    const variants = bodies.flatMap(body => [{ body, gzip: false }, ...(
        opts.gzip === 'force' || (opts.gzip === 'auto' && checks.some(check =>
            check.client === 'node' && check.size === body.label && check.verdict === 'supported'))
            ? [{ body, gzip: true }] : [])]);
    const uploadBytes = variants.reduce((sum, variant) => sum + (variant.gzip ? variant.body.gzipBytes : variant.body.jsonBytes), 0) * opts.rounds;
    console.log(`\nNode timing ${variants.length} variants x ${opts.rounds} rounds (${variants.length * opts.rounds} requests, about ${kb(uploadBytes)} upload)`);
    let consecutiveMismatches = 0;
    for (let round = 1; round <= opts.rounds; round++) {
        const order = [...variants];
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
        for (const variant of order) {
            const sample = await run(variant.body, variant.gzip, 'timing');
            const knownPlain = plainBySize.get(variant.body.label);
            const gzipSupported = checks.some(check => check.client === 'node' && check.size === variant.body.label && check.verdict === 'supported');
            const expected = variant.gzip && !gzipSupported ? null : knownPlain?.replyKey ?? baseline.replyKey;
            sample.valid = expected !== null && sample.replyKey === expected && isEffortRejection(sample);
            console.log(`  r${round} ${line(sample)}${sample.valid || expected === null ? '' : '  [different reply, excluded]'}`);
            consecutiveMismatches = sample.valid || expected === null ? 0 : consecutiveMismatches + 1;
            if (consecutiveMismatches >= 3) fail('three replies in a row differed from the baseline; stopping.', 3);
        }
    }

    const timing = samples.filter(sample => sample.phase === 'timing' && sample.valid);
    console.log('\nVariant        json        wire     median      min      max   n');
    const summary = [];
    for (const variant of variants) {
        const group = timing.filter(sample => sample.size === variant.body.label && sample.gzip === variant.gzip).map(sample => sample.ttfbMs);
        const row = {
            size: variant.body.label, gzip: variant.gzip, jsonBytes: variant.body.jsonBytes,
            wireBytes: variant.gzip ? variant.body.gzipBytes : variant.body.jsonBytes,
            medianMs: group.length ? Math.round(median(group)) : null,
            minMs: group.length ? Math.round(Math.min(...group)) : null, maxMs: group.length ? Math.round(Math.max(...group)) : null, n: group.length
        };
        summary.push(row);
        console.log(`${(variant.gzip ? 'gzip  ' : 'plain ') + row.size.padEnd(7)}${kb(row.jsonBytes).padStart(10)}${kb(row.wireBytes).padStart(12)}`
            + `${ms(row.medianMs).padStart(11)}${ms(row.minMs).padStart(9)}${ms(row.maxMs).padStart(9)}${String(row.n).padStart(4)}`);
    }

    const fit = fitLine(timing.filter(sample => !sample.gzip).map(sample => [sample.wireBytes, sample.ttfbMs]));
    if (fit) {
        console.log(`\nUpload fit (plain bodies): ${fit.mbPerSecond ? `${fit.mbPerSecond.toFixed(2)} MB/s (${(fit.mbPerSecond * 8).toFixed(1)} Mbit/s)` : 'no size effect'}; `
            + `${Math.round(fit.msPer100kB)} ms per 100 kB; fixed overhead ${Math.round(fit.interceptMs)} ms; R^2 ${fit.r2.toFixed(2)}`);
    } else {
        console.log('\nUpload fit: needs at least two sizes and three valid samples.');
    }
    for (const row of summary.filter(item => item.gzip && item.medianMs !== null)) {
        const plain = summary.find(item => !item.gzip && item.size === row.size);
        if (Number.isFinite(plain?.medianMs)) {
            console.log(`gzip ${row.size}: ${kb(row.wireBytes)} on the wire instead of ${kb(plain.wireBytes)}; `
                + `median ${ms(row.medianMs)} vs ${ms(plain.medianMs)} (${plain.medianMs - row.medianMs >= 0 ? 'saves' : 'costs'} ${ms(Math.abs(plain.medianMs - row.medianMs))})`);
        }
    }
    const nodeSamples = samples.filter(sample => sample.client === 'node');
    const newConnections = nodeSamples.filter(sample => !sample.reusedSocket).length;
    if (newConnections > 1) console.log(`Note: ${newConnections} of ${nodeSamples.length} Node requests opened a new connection; handshakes can affect the timing fit.`);
    finish(fit, summary);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => fail(sanitize(error?.stack || error)));
}
