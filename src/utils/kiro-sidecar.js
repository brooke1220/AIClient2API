/** Owns one authenticated Rust sidecar instance and its bounded restart loop. */
import { spawn } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'node:timers/promises';
import logger from './logger.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KIRO_TRANSPORT_PROFILE = 'v1-aws-lc-rs';
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 5;

/** Derive exact origins from explicit configuration, including account endpoints. */
export async function getKiroSidecarTargetOrigins(config = {}) {
    const nodes = [config, ...Object.entries(config.providerPools || {})
        .filter(([type]) => type.startsWith('claude-kiro')).flatMap(([, entries]) => entries)];
    const origins = new Set();
    for (const node of nodes) {
        const regions = new Set(['us-east-1', 'eu-west-1', 'ap-southeast-1']);
        let credentials;
        try {
            if (node.KIRO_OAUTH_CREDS_BASE64) credentials = JSON.parse(Buffer.from(node.KIRO_OAUTH_CREDS_BASE64, 'base64').toString());
            else {
                const directory = node.KIRO_OAUTH_CREDS_DIR_PATH || config.KIRO_OAUTH_CREDS_DIR_PATH || path.join(os.homedir(), '.aws', 'sso', 'cache');
                const file = node.KIRO_OAUTH_CREDS_FILE_PATH || path.join(directory, 'kiro-auth-token.json');
                credentials = JSON.parse(await fs.promises.readFile(file, 'utf8'));
            }
        } catch (err) {
            // File-not-found is expected when no cached credentials exist yet;
            // parse failures may indicate a corrupt file and warrant a warning.
            if (err?.code !== 'ENOENT') logger.warn(`[Kiro-Sidecar] Could not load credential regions: ${err?.message || err}`);
        }
        for (const region of [node.region, node.idcRegion, credentials?.region, credentials?.idcRegion]) {
            if (typeof region === 'string' && /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) regions.add(region);
        }
        for (const region of regions) {
            for (const endpoint of [
                `https://q.${region}.amazonaws.com`, `https://codewhisperer.${region}.amazonaws.com`,
                `https://runtime.${region}.kiro.dev`, node.KIRO_BASE_URL ?? config.KIRO_BASE_URL,
                node.KIRO_API_KEY_BASE_URL ?? config.KIRO_API_KEY_BASE_URL,
            ]) {
                if (!endpoint) continue;
                const url = new URL(endpoint.replaceAll('{{region}}', region));
                if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Kiro sidecar endpoints must be HTTPS URLs without credentials or fragments');
                origins.add(url.origin);
            }
        }
    }
    return [...origins];
}

export default class KiroSidecar {
    constructor(timings = {}) {
        this.timings = { startup: 10000, healthInterval: 30000, health: 3000, stop: 5000, backoff: 2000, ...timings };
        this.process = null;
        this.record = null;
        this.port = 9091;
        this.baseUrl = null;
        this.state = 'stopped';
        this.startPromise = null;
        this.stopPromise = null;
        this.healthCheckTimer = null;
        this.backoffTimer = null;
        this.localToken = null;
        this.instanceId = null;
        this.restartTimestamps = [];
        this.currentBackoff = this.timings.backoff;
        this.consecutiveHealthFailures = 0;
        this.isShuttingDown = false;
        this.options = {};
        this.httpAgent = new http.Agent({ keepAlive: true });
    }

    start(options = {}) {
        if (this.stopPromise || this.state === 'stopping') return Promise.resolve(false);
        if (this.startPromise) return this.startPromise;
        if (this.record) return Promise.resolve(this.isReady());
        clearTimeout(this.backoffTimer);
        this.backoffTimer = null;
        if (this.state === 'unavailable') {
            this.restartTimestamps = [];
            this.currentBackoff = this.timings.backoff;
        }
        this.isShuttingDown = false;
        this.options = options;
        this.port = options.port || Number(process.env.KIRO_SIDECAR_PORT) || 9091;
        this.baseUrl = `http://127.0.0.1:${this.port}`;
        return this._launch();
    }

    _launch() {
        const operation = this._doStart();
        this.startPromise = operation;
        const clear = () => { if (this.startPromise === operation) this.startPromise = null; };
        operation.then(clear, clear);
        return operation;
    }

    async _doStart() {
        this.state = 'starting';
        const binaryPath = this.options.binaryPath || this._findBinary();
        if (!binaryPath) {
            this.state = 'unavailable';
            logger.error('[Kiro-Sidecar] Binary not found');
            return false;
        }
        let record;
        try {
            const token = randomBytes(32).toString('hex');
            const id = randomUUID();
            const child = spawn(binaryPath, [], {
                env: {
                    ...process.env,
                    KIRO_SIDECAR_PORT: String(this.port), KIRO_SIDECAR_INSTANCE_ID: id, KIRO_SIDECAR_TOKEN: token,
                    KIRO_SIDECAR_MANAGED: '1', KIRO_SIDECAR_TRANSPORT_PROFILE: KIRO_TRANSPORT_PROFILE,
                    KIRO_SIDECAR_MAX_PAYLOAD_BYTES: String(this.options.maxPayloadBytes || 10 * 1024 * 1024),
                    KIRO_SIDECAR_TARGET_ALLOWLIST: [process.env.KIRO_SIDECAR_TARGET_ALLOWLIST, ...(this.options.targetOrigins || [])].filter(Boolean).join(','),
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let exited;
            record = { child, token, id, baseUrl: this.baseUrl, port: this.port, controller: new AbortController(), exited: false, stopping: false,
                exitPromise: new Promise(resolve => { exited = resolve; }) };
            this.record = record;
            this.process = child;
            this.localToken = token;
            this.instanceId = id;
            const onExit = () => {
                if (record.exited) return;
                record.exited = true;
                record.controller.abort();
                exited();
                if (this.record !== record || record.stopping || this.state === 'starting' || this.isShuttingDown) return;
                this._detach(record);
                this._scheduleRestart();
            };
            child.once('exit', onExit);
            child.once('error', error => {
                logger.error(`[Kiro-Sidecar] Cannot spawn sidecar (${error.code || 'SPAWN_ERROR'})`);
                onExit();
            });
            child.stdin.on('error', () => {});
            child.stdout.on('data', data => logger.info(`[Kiro-Sidecar] ${data.toString().trim()}`));
            child.stderr.on('data', data => logger.error(`[Kiro-Sidecar] ${data.toString().trim()}`));
            if (await this._waitForReady(record) && this.record === record && !record.exited && !this.isShuttingDown) {
                this.state = 'ready';
                this.consecutiveHealthFailures = 0;
                this._startHealthCheck(record);
                return true;
            }
            if (!this.isShuttingDown) logger.warn('[Kiro-Sidecar] Startup readiness check failed');
            await this._terminate(record);
            this._detach(record);
        } catch {
            logger.error('[Kiro-Sidecar] Failed to start sidecar');
            if (record) {
                await this._terminate(record);
                this._detach(record);
            }
        }
        if (!this.isShuttingDown) this._scheduleRestart();
        return false;
    }

    _detach(record) {
        if (this.record !== record) return;
        this._stopHealthCheck();
        this.record = null;
        this.process = null;
        this.localToken = null;
        this.instanceId = null;
    }

    _scheduleRestart() {
        if (this.isShuttingDown || this.backoffTimer) return;
        this.restartTimestamps = this.restartTimestamps.filter(t => Date.now() - t < RESTART_WINDOW_MS);
        if (this.restartTimestamps.length >= MAX_RESTARTS) {
            this.state = 'unavailable';
            return;
        }
        this.state = 'backoff';
        this.backoffTimer = setTimeout(() => {
            this.backoffTimer = null;
            if (this.isShuttingDown) return;
            this.restartTimestamps.push(Date.now());
            this._launch();
        }, this.currentBackoff);
        this.currentBackoff = Math.min(this.currentBackoff * 2, 30000);
        this.backoffTimer.unref?.();
    }

    _terminate(record) {
        if (record.stopPromise) return record.stopPromise;
        record.stopping = true;
        record.controller.abort();
        record.stopPromise = (async () => {
            if (record.exited) return;
            const force = setTimeout(() => { if (!record.exited) record.child.kill('SIGKILL'); }, this.timings.stop);
            try {
                record.child.kill('SIGTERM');
                await record.exitPromise;
            } finally { clearTimeout(force); }
        })();
        return record.stopPromise;
    }

    stop() {
        if (this.stopPromise) return this.stopPromise;
        this.isShuttingDown = true;
        this.state = 'stopping';
        clearTimeout(this.backoffTimer);
        this.backoffTimer = null;
        this._stopHealthCheck();
        const record = this.record;
        const starting = this.startPromise;
        const operation = (async () => {
            if (record) await this._terminate(record);
            // _terminate aborts the record's controller, which interrupts
            // _waitForReady; add a deadline in case _doStart is blocked elsewhere.
            if (starting) await Promise.race([starting, sleep(this.timings.stop + this.timings.startup)]);
            if (record) this._detach(record);
            this.httpAgent.destroy();
            this.httpAgent = new http.Agent({ keepAlive: true });
            this.state = 'stopped';
        })();
        this.stopPromise = operation;
        const clear = () => { if (this.stopPromise === operation) this.stopPromise = null; };
        operation.then(clear, clear);
        return operation;
    }

    async _waitForReady(record) {
        const deadline = Date.now() + this.timings.startup;
        while (!record.controller.signal.aborted && Date.now() < deadline) {
            if (await this._healthCheck(record, Math.min(this.timings.health, deadline - Date.now()))) return true;
            try { await sleep(Math.min(100, Math.max(0, deadline - Date.now())), undefined, { signal: record.controller.signal }); }
            catch { return false; }
        }
        return false;
    }

    _healthCheck(record, timeout = this.timings.health) {
        return new Promise(resolve => {
            let settled = false;
            let timer;
            const finish = ok => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
            const req = http.request({ hostname: '127.0.0.1', port: record.port, path: '/health', agent: this.httpAgent,
                signal: record.controller.signal,
                headers: { 'X-Kiro-Sidecar-Token': record.token, 'X-Kiro-Protocol-Version': '1' },
            }, res => {
                let body = '';
                res.on('data', chunk => {
                    body += chunk;
                    if (body.length > 4096) { finish(false); res.destroy(); }
                });
                res.on('error', () => finish(false));
                res.on('aborted', () => finish(false));
                res.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        finish(res.statusCode === 200 && res.headers['x-kiro-protocol-version'] === '1'
                            && res.headers['x-kiro-response-source'] === 'sidecar' && data.status === 'ok'
                            && data.service === 'kiro-sidecar' && data.protocol_version === 1
                            && data.instance_id === record.id && data.transport_profile === KIRO_TRANSPORT_PROFILE);
                    } catch { finish(false); }
                });
            });
            timer = setTimeout(() => { finish(false); req.destroy(); }, Math.max(1, timeout));
            req.on('error', () => finish(false));
            req.end();
        });
    }

    _startHealthCheck(record) {
        this._stopHealthCheck();
        this.healthCheckTimer = setTimeout(async () => {
            const ok = await this._healthCheck(record);
            if (this.record !== record || record.stopping || this.isShuttingDown) return;
            this.consecutiveHealthFailures = ok ? 0 : this.consecutiveHealthFailures + 1;
            this.state = ok ? 'ready' : 'unhealthy';
            if (this.consecutiveHealthFailures >= 3) {
                await this._terminate(record);
                this._detach(record);
                this._scheduleRestart();
            } else this._startHealthCheck(record);
        }, this.timings.healthInterval);
        this.healthCheckTimer.unref?.();
    }

    _stopHealthCheck() { clearTimeout(this.healthCheckTimer); this.healthCheckTimer = null; }
    isReady() { return this.state === 'ready' && this.record !== null && !this.record.exited; }
    getBaseUrl() { return this.isReady() ? this.baseUrl : null; }
    getLocalToken() { return this.localToken; }
    getInstanceId() { return this.instanceId; }
    getHttpAgent() { return this.httpAgent; }
    getTransportContext() {
        if (!this.isReady()) return null;
        return Object.freeze({ kind: 'kiro-sidecar', baseUrl: this.baseUrl, localToken: this.localToken,
            instanceId: this.instanceId, agent: this.httpAgent });
    }

    _findBinary() {
        const ext = process.platform === 'win32' ? '.exe' : '';
        for (const candidate of [path.join(projectRoot, 'kiro-sidecar', `kiro-sidecar${ext}`),
            path.join(projectRoot, `kiro-sidecar${ext}`), `/app/kiro-sidecar/kiro-sidecar${ext}`]) {
            try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
        }
        return null;
    }
}

let instance;
export function getKiroSidecar() { return instance ??= new KiroSidecar(); }
