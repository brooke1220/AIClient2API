#!/usr/bin/env node
/**
 * Zero-credit upload probe for the AIClient2API -> Kiro hop.
 *
 * Every request sets an invalid output_config.effort, so Kiro answers HTTP 400
 * after it has received and parsed the whole body, before any model runs.
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
import { mergeConfig } from '../utils/config-merge.js';
import { resolveProxyUrlForProvider } from '../utils/proxy-utils.js';

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
Every request is rejected by Kiro before generation, so no credits are used.

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
  --proxy <url|none>       HTTP(S) proxy (default: the account's sidecar proxy setting)
  --gzip <auto|force|off>  auto: time gzip bodies only if Kiro accepts them (default)
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
        proxy: null, gzip: 'auto', json: null, dryRun: false
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
            case '--json': opts.json = value(); break;
            case '--dry-run': opts.dryRun = true; break;
            case '-h': case '--help': console.log(HELP); process.exit(0);
            default: fail(`unknown option ${arg} (see --help)`);
        }
    }
    if (!Number.isSafeInteger(opts.rounds) || opts.rounds < 1 || opts.rounds > 10) fail('--rounds must be 1-10');
    if (!Number.isFinite(opts.gapMs) || opts.gapMs < 0) fail('--gap-ms must be >= 0');
    if (!['auto', 'force', 'off'].includes(opts.gzip)) fail('--gzip must be auto, force or off');
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
    if (!['http:', 'https:'].includes(url.protocol)) {
        fail(`${url.protocol.replace(':', '')} proxies are not supported by this probe; pass an HTTP proxy with --proxy, or --proxy none`);
    }
    return url;
}

const describeProxy = url => url
    ? `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}${url.username ? ' (with auth)' : ''}`
    : 'none (direct)';

// ---- transport: one keep-alive connection, optionally through an HTTP CONNECT proxy ----

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
    const target = `${options.host}:${options.port || 443}`;
    const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
    if (proxy.username) {
        const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}`);
    }
    const onConnect = () => raw.write(`${lines.join('\r\n')}\r\n\r\n`);
    const onSecureConnect = () => finish(null, secure);
    let head = Buffer.alloc(0);
    const onData = chunk => {
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
        // Preserve bytes read beyond the CONNECT headers for the TLS socket.
        const remainder = head.subarray(end + 4);
        if (remainder.length) raw.unshift(remainder);
        try {
            secure = (transport.connectTls || tls.connect)({ socket: raw, servername: options.servername || options.host });
            secure.once('secureConnect', onSecureConnect);
            secure.once('error', finish);
            secure.once('end', onClosed);
            secure.once('close', onClosed);
        } catch (error) { finish(error); }
    };
    if (signal?.aborted) { onAbort(); return; }
    const port = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    try {
        raw = proxy.protocol === 'https:'
            ? (transport.connectTls || tls.connect)({ host: proxy.hostname, port, servername: proxy.hostname })
            : (transport.connect || net.connect)({ host: proxy.hostname, port });
        raw.once('error', finish);
        raw.once('end', onClosed);
        raw.once('close', onClosed);
        raw.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', onConnect);
        raw.on('data', onData);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    } catch (error) { finish(error); }
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

function makeBody(size, index, model, profileArn) {
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
    const object = build(history);
    const json = Buffer.from(JSON.stringify(object));
    return { label: size.label, object, jsonBytes: json.length, gzipBytes: zlib.gzipSync(json, { level: 6 }).length };
}

function encode(body, gzip) {
    body.object.conversationState.conversationId = crypto.randomUUID();
    const json = Buffer.from(JSON.stringify(body.object));
    return { json, payload: gzip ? zlib.gzipSync(json, { level: 6 }) : json };
}

function headersFor(token, payload, gzip) {
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

function describeReply(result) {
    if (result.error) return { key: `error:${result.error.code || result.error.message}`, text: sanitize(result.error.code || result.error.message) };
    const type = String(result.headers?.['x-amzn-errortype'] || '').split(':')[0];
    let reason = '';
    let message = result.text || '';
    try {
        const parsed = JSON.parse(result.text);
        reason = parsed.reason || '';
        message = parsed.message || parsed.Message || parsed.__type || result.text;
    } catch { /* not JSON */ }
    message = sanitize(message).replace(/\s+/g, ' ').trim().slice(0, 240);
    const normalized = message.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'ID');
    return {
        key: `${result.status}|${type}|${reason}|${normalized}`,
        text: [result.status, type, reason].filter(Boolean).join(' ') + (message ? `: ${message}` : '')
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
    const largest = bodies.at(-1);
    const minutesLeft = Number.isFinite(account.expiresAt) ? `${Math.round((account.expiresAt - Date.now()) / 60000)} min` : 'unknown';

    console.log('Kiro upload probe: every request carries an invalid effort value and is rejected before generation.');
    console.log(`  account   ${account.label}  auth=${account.authMethod}  region=${account.region}  token valid for ${minutesLeft}`);
    console.log(`  endpoint  ${url.origin}${url.pathname}`);
    console.log(`  proxy     ${describeProxy(proxy)}`);
    console.log(`  model     ${opts.model}`);
    console.log(`  bodies    ${bodies.map(body => `${body.label}=${kb(body.jsonBytes)}`).join(', ')}; `
        + `gzip of the largest: ${kb(largest.gzipBytes)} (${(100 * largest.gzipBytes / largest.jsonBytes).toFixed(0)}%)`);
    if (opts.dryRun) {
        console.log('Dry run: nothing was sent.');
        return;
    }

    const agent = createAgent(proxy);
    const samples = [];
    const run = async (body, gzip, phase) => {
        const { json, payload } = encode(body, gzip);
        const result = await send(agent, url, headersFor(account.token, payload, gzip), payload);
        if (result.unsafe) {
            console.error(`\nKiro returned HTTP ${result.status} for ${gzip ? 'gzip' : 'plain'} ${body.label}: the invalid effort was not rejected.`);
            console.error('The connection was dropped at once to stop generation. Check this account\'s usage before running again.');
            process.exit(2);
        }
        const reply = describeReply(result);
        const sample = {
            phase, size: body.label, gzip, jsonBytes: json.length, wireBytes: payload.length, status: result.status,
            ttfbMs: result.ttfbMs, writeMs: result.writeMs, reusedSocket: result.reusedSocket === true, replyKey: reply.key, reply: reply.text
        };
        samples.push(sample);
        return sample;
    };
    const line = sample => `${sample.gzip ? 'gzip ' : 'plain'} ${sample.size.padEnd(6)} wire ${kb(sample.wireBytes).padStart(9)}  `
        + `ttfb ${ms(sample.ttfbMs).padStart(8)}  ${sample.reply.slice(0, 110)}${sample.reusedSocket ? '' : '  [new connection]'}`;

    const smallest = bodies[0];
    const baseline = await run(smallest, false, 'baseline');
    console.log(`\nBaseline  ${line(baseline)}`);
    if (baseline.status !== 400) {
        fail(`expected HTTP 400 from the invalid effort, got: ${baseline.reply}. Nothing else was sent.`, 3);
    }
    if (!/effort|probe-invalid-effort/i.test(baseline.reply)) {
        console.log('  Note: the 400 does not mention effort. Timings are only comparable where every body gets this same reply.');
    }

    let gzipAccepted = null;
    if (opts.gzip !== 'off') {
        await sleep(opts.gapMs);
        const check = await run(smallest, true, 'gzip-check');
        gzipAccepted = check.replyKey === baseline.replyKey;
        console.log(`Gzip      ${line(check)}`);
        console.log(gzipAccepted
            ? '  => Kiro decoded the gzip body (same rejection as the plain body).'
            : '  => Kiro did not treat the gzip body like the plain one (reply above).');
    }

    const timeGzip = opts.gzip === 'force' || (opts.gzip === 'auto' && gzipAccepted);
    const variants = bodies.flatMap(body => [{ body, gzip: false }, ...(timeGzip ? [{ body, gzip: true }] : [])]);
    const uploadBytes = variants.reduce((sum, variant) => sum + (variant.gzip ? variant.body.gzipBytes : variant.body.jsonBytes), 0) * opts.rounds;
    console.log(`\nTiming ${variants.length} variants x ${opts.rounds} rounds (${variants.length * opts.rounds} requests, about ${kb(uploadBytes)} upload)`);
    let consecutiveMismatches = 0;
    for (let round = 1; round <= opts.rounds; round++) {
        const order = [...variants];
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
        for (const variant of order) {
            await sleep(opts.gapMs);
            const sample = await run(variant.body, variant.gzip, 'timing');
            const expected = variant.gzip && !gzipAccepted ? null : baseline.replyKey;
            sample.valid = expected !== null && sample.replyKey === expected;
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
    const newConnections = samples.filter(sample => !sample.reusedSocket).length;
    if (newConnections > 1) console.log(`Note: ${newConnections} of ${samples.length} requests opened a new connection; handshakes add to the fixed overhead, not the slope.`);

    const result = {
        probe: 'kiro-upload', at: new Date().toISOString(), account: account.label, authMethod: account.authMethod, region: account.region,
        endpoint: `${url.origin}${url.pathname}`, proxy: describeProxy(proxy), model: opts.model, gzipAccepted,
        baseline: baseline.reply, fit, summary,
        samples: samples.map(({ replyKey, ...sample }) => ({ ...sample, ttfbMs: Math.round(sample.ttfbMs), writeMs: sample.writeMs === null ? null : Math.round(sample.writeMs) }))
    };
    if (opts.json) {
        fs.writeFileSync(opts.json, `${JSON.stringify(result, null, 2)}\n`);
        console.log(`Wrote ${opts.json}`);
    }
    console.log(`\nRESULT ${JSON.stringify({ gzipAccepted, fit, summary, proxy: result.proxy, endpoint: result.endpoint, baseline: result.baseline })}`);
    agent.destroy();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => fail(sanitize(error?.stack || error)));
}
