/**
 * Kiro Sidecar Manager
 *
 * Manages the Rust kiro-sidecar process lifecycle:
 * - State machine: stopped → starting → ready ↔ unhealthy → backoff → unavailable
 * - Rolling restart budget: max 5 restarts in 10 minutes
 * - Local auth token and instance ID generation per spawn
 * - Parent-pipe monitoring (stdin close → child exits)
 */

import { spawn } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const moduleFilename = fileURLToPath(import.meta.url);
const moduleDirname = path.dirname(moduleFilename);

const DEFAULT_PORT = 9091;
const HEALTH_CHECK_INTERVAL = 30000;
const HEALTH_CHECK_TIMEOUT = 3000;
const STARTUP_TIMEOUT = 10000;
const MAX_RESTARTS_IN_WINDOW = 5;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const STOP_TIMEOUT_MS = 5000;

const STATES = {
    STOPPED: 'stopped',
    STARTING: 'starting',
    READY: 'ready',
    UNHEALTHY: 'unhealthy',
    BACKOFF: 'backoff',
    UNAVAILABLE: 'unavailable',
    STOPPING: 'stopping',
};

class KiroSidecar {
    constructor() {
        this.process = null;
        this.port = DEFAULT_PORT;
        this.baseUrl = null;
        this.state = STATES.STOPPED;
        this.healthCheckTimer = null;
        this.backoffTimer = null;
        this.startPromise = null;
        this.localToken = null;
        this.instanceId = null;
        this.consecutiveHealthFailures = 0;
        this.restartTimestamps = [];
        this.currentBackoff = INITIAL_BACKOFF_MS;
        this.isShuttingDown = false;
        this.options = {};
        this.httpAgent = new http.Agent({ keepAlive: true });
    }

    /**
     * Start the sidecar process. Concurrent calls share the same promise.
     * @param {Object} options
     * @param {number} [options.port] - 监听端口
     * @param {string} [options.binaryPath] - 自定义二进制路径
     * @param {number} [options.maxPayloadBytes] - 请求 body 上限
     * @returns {Promise<boolean>}
     */
    async start(options = {}) {
        if (this.state === STATES.STOPPING) {
            logger.warn('[Kiro-Sidecar] Cannot start while stopping');
            return false;
        }
        if (this.state === STATES.READY || this.state === STATES.STARTING) {
            return this.startPromise || true;
        }

        this.options = options;
        this.port = options.port || parseInt(process.env.KIRO_SIDECAR_PORT) || DEFAULT_PORT;
        this.baseUrl = `http://127.0.0.1:${this.port}`;

        const binaryPath = options.binaryPath || this._findBinary();
        if (!binaryPath) {
            logger.error('[Kiro-Sidecar] Binary not found');
            return false;
        }

        this.startPromise = this._doStart(binaryPath);
        const result = await this.startPromise;
        this.startPromise = null;
        return result;
    }
    async _doStart(binaryPath) {
        this.state = STATES.STARTING;

        // Generate fresh credentials for this instance
        this.localToken = randomBytes(32).toString('hex');
        this.instanceId = randomUUID();

        try {
            if (process.platform !== 'win32') {
                try { fs.chmodSync(binaryPath, 0o755); } catch {}
            }

            this.process = spawn(binaryPath, [], {
                env: {
                    ...process.env,
                    KIRO_SIDECAR_PORT: String(this.port),
                    KIRO_SIDECAR_INSTANCE_ID: this.instanceId,
                    KIRO_SIDECAR_TOKEN: this.localToken,
                    KIRO_SIDECAR_MAX_PAYLOAD_BYTES: String(this.options.maxPayloadBytes || 10 * 1024 * 1024),
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            this.process.stdout.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) logger.info(`[Kiro-Sidecar] ${msg}`);
            });

            this.process.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) logger.error(`[Kiro-Sidecar] ${msg}`);
            });

            // Single exit handler — prevents double-scheduling restarts
            let exitHandled = false;
            this.process.on('exit', (code, signal) => {
                if (exitHandled) return;
                exitHandled = true;
                logger.warn(`[Kiro-Sidecar] Process exited (code=${code}, signal=${signal})`);
                this._handleExit();
            });

            this.process.on('error', (err) => {
                if (exitHandled) return;
                exitHandled = true;
                logger.error(`[Kiro-Sidecar] Spawn error: ${err.message}`);
                this._handleExit();
            });
            const ok = await this._waitForReady();
            if (ok) {
                this.state = STATES.READY;
                this.consecutiveHealthFailures = 0;
                this.currentBackoff = INITIAL_BACKOFF_MS;
                this._startHealthCheck();
                logger.info(`[Kiro-Sidecar] Ready at ${this.baseUrl}, instance=${this.instanceId}`);
                return true;
            } else {
                this._cleanup();
                this.state = STATES.STOPPED;
                return false;
            }
        } catch (err) {
            logger.error(`[Kiro-Sidecar] Failed to start: ${err.message}`);
            this._cleanup();
            this.state = STATES.STOPPED;
            return false;
        }
    }

    _handleExit() {
        this._cleanup();
        if (this.isShuttingDown || this.state === STATES.STOPPING) return;

        this.state = STATES.BACKOFF;
        if (this._hasRestartBudget()) {
            this.restartTimestamps.push(Date.now());
            logger.info(`[Kiro-Sidecar] Scheduling restart in ${this.currentBackoff}ms`);
            this.backoffTimer = setTimeout(() => {
                this.backoffTimer = null;
                if (this.state === STATES.STOPPING || this.isShuttingDown) return;
                this.start(this.options);
            }, this.currentBackoff);
            this.currentBackoff = Math.min(this.currentBackoff * 2, MAX_BACKOFF_MS);
        } else {
            this.state = STATES.UNAVAILABLE;
            logger.error('[Kiro-Sidecar] Restart budget exhausted, entering unavailable state');
        }
    }

    _hasRestartBudget() {
        const now = Date.now();
        this.restartTimestamps = this.restartTimestamps.filter(t => now - t < RESTART_WINDOW_MS);
        return this.restartTimestamps.length < MAX_RESTARTS_IN_WINDOW;
    }
    /**
     * 停止 sidecar 进程
     */
    async stop() {
        this.isShuttingDown = true;
        this.state = STATES.STOPPING;
        this._stopHealthCheck();
        if (this.backoffTimer) {
            clearTimeout(this.backoffTimer);
            this.backoffTimer = null;
        }

        if (this.process) {
            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    if (this.process) {
                        logger.warn('[Kiro-Sidecar] Force killing');
                        this.process.kill('SIGKILL');
                    }
                    this._finalCleanup();
                    resolve();
                }, STOP_TIMEOUT_MS);

                this.process.once('exit', () => {
                    clearTimeout(timeout);
                    this._finalCleanup();
                    resolve();
                });

                this.process.kill('SIGTERM');
            });
        }
        this._finalCleanup();
    }

    _cleanup() {
        this.process = null;
        this._stopHealthCheck();
    }

    _finalCleanup() {
        this.process = null;
        this.state = STATES.STOPPED;
        this.localToken = null;
        this.instanceId = null;
        this._stopHealthCheck();
        if (this.httpAgent) {
            this.httpAgent.destroy();
            this.httpAgent = new http.Agent({ keepAlive: true });
        }
    }
    /**
     * 检查 sidecar 是否就绪
     * @returns {boolean}
     */
    isReady() {
        return this.state === STATES.READY && this.process !== null;
    }

    /**
     * 获取 sidecar base URL
     * @returns {string|null}
     */
    getBaseUrl() { return this.isReady() ? this.baseUrl : null; }

    /**
     * 获取当前本地认证令牌
     * @returns {string|null}
     */
    getLocalToken() { return this.localToken; }

    /**
     * 获取当前实例 ID
     * @returns {string|null}
     */
    getInstanceId() { return this.instanceId; }

    /**
     * 获取 keep-alive HTTP agent
     * @returns {http.Agent}
     */
    getHttpAgent() { return this.httpAgent; }

    // ──── 内部方法 ────

    _findBinary() {
        const projectRoot = path.resolve(moduleDirname, '..', '..');
        const isWin = process.platform === 'win32';
        const ext = isWin ? '.exe' : '';
        const candidates = [
            path.join(projectRoot, 'kiro-sidecar', `kiro-sidecar${ext}`),
            path.join(projectRoot, `kiro-sidecar${ext}`),
            path.join('/app', 'kiro-sidecar', `kiro-sidecar${ext}`),
            path.join('/app', `kiro-sidecar${ext}`),
        ];
        for (const p of candidates) {
            try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
        }
        return null;
    }
    async _waitForReady(timeoutMs = STARTUP_TIMEOUT) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                if (await this._healthCheck()) return true;
            } catch {}
            await sleep(500);
        }
        logger.error('[Kiro-Sidecar] Startup timeout');
        return false;
    }

    _healthCheck() {
        return new Promise((resolve) => {
            const opts = {
                hostname: '127.0.0.1',
                port: this.port,
                path: '/health',
                method: 'GET',
                timeout: HEALTH_CHECK_TIMEOUT,
                agent: this.httpAgent,
                headers: {
                    'X-Kiro-Sidecar-Token': this.localToken || '',
                    'X-Kiro-Protocol-Version': '1',
                },
            };
            const req = http.request(opts, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) return resolve(false);
                    try {
                        const data = JSON.parse(body);
                        // Verify instance identity
                        if (data.instance_id !== this.instanceId) {
                            logger.warn('[Kiro-Sidecar] Instance ID mismatch in health check');
                            return resolve(false);
                        }
                        resolve(true);
                    } catch {
                        resolve(false);
                    }
                });
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
    }

    _startHealthCheck() {
        this._stopHealthCheck();
        this.healthCheckTimer = setInterval(async () => {
            const ok = await this._healthCheck();
            if (!ok) {
                this.consecutiveHealthFailures++;
                if (this.state === STATES.READY) {
                    this.state = STATES.UNHEALTHY;
                    logger.warn('[Kiro-Sidecar] Health check failed, marking unhealthy');
                }
                if (this.consecutiveHealthFailures >= 3 && this.process) {
                    logger.warn('[Kiro-Sidecar] 3 consecutive health failures, restarting');
                    this._stopHealthCheck();
                    this.process.kill('SIGTERM');
                    // Exit handler will schedule restart
                }
            } else {
                if (this.state === STATES.UNHEALTHY) {
                    this.state = STATES.READY;
                    logger.info('[Kiro-Sidecar] Health recovered');
                }
                this.consecutiveHealthFailures = 0;
            }
        }, HEALTH_CHECK_INTERVAL);
        this.healthCheckTimer.unref?.();
    }

    _stopHealthCheck() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// 单例
let instance = null;

export function getKiroSidecar() {
    if (!instance) instance = new KiroSidecar();
    return instance;
}

export default KiroSidecar;
