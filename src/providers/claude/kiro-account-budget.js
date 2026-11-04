import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export function kiroCredentialFileForConfig(config = {}, directory = config.KIRO_OAUTH_CREDS_DIR_PATH || path.join(os.homedir(), '.aws', 'sso', 'cache')) {
    if (config.KIRO_OAUTH_CREDS_BASE64) {
        try {
            // Match the constructor: invalid Base64 credentials fall back to
            // the default file, never to the lower-priority configured file.
            JSON.parse(Buffer.from(config.KIRO_OAUTH_CREDS_BASE64, 'base64').toString('utf8'));
            const fingerprint = createHash('sha256').update(config.KIRO_OAUTH_CREDS_BASE64).digest('hex');
            return path.join(directory, '.kiro-base64', `${fingerprint}.json`);
        } catch { return path.join(directory, 'kiro-auth-token.json'); }
    }
    return config.KIRO_OAUTH_CREDS_FILE_PATH || path.join(directory, 'kiro-auth-token.json');
}

function accountKey(apiKey, file) {
    return createHash('sha256').update(JSON.stringify(
        apiKey ? ['api-key', apiKey] : ['credential-file', path.resolve(file)]
    )).digest('hex');
}

/** Resolve the same account identity without initializing a service or reading credentials. */
export function kiroBudgetKeyForConfig(config = {}) {
    const apiKey = config.KIRO_API_KEY || process.env.KIRO_API_KEY;
    return accountKey(apiKey, apiKey ? null : kiroCredentialFileForConfig(config));
}

export function kiroBudgetKey(service) {
    if (service._kiroBudgetKey) return service._kiroBudgetKey;
    const config = service.config || {};
    const apiKey = service.apiKey || config.KIRO_API_KEY || process.env.KIRO_API_KEY;
    return service._kiroBudgetKey = accountKey(apiKey,
        apiKey ? null : service.credsFilePath || kiroCredentialFileForConfig(config, service.credPath));
}

function budgetLimits(config) {
    const configuredInterval = Number(config.KIRO_ACCOUNT_MIN_INTERVAL_MS);
    const interval = Number.isSafeInteger(configuredInterval) && configuredInterval > 0 && configuredInterval <= 2147483647 ? configuredInterval : 0;
    const configuredRpm = Number(config.KIRO_ACCOUNT_REQUESTS_PER_MINUTE);
    const rpm = Number.isSafeInteger(configuredRpm) && configuredRpm > 0 ? configuredRpm : 0;
    return { interval, rpm };
}

function waitForBudget(state, { interval, rpm }, now) {
    const starts = state.starts.filter(time => now - time < 60_000);
    return Math.max(0, state.last + interval - now,
        rpm && starts.length >= rpm ? starts[starts.length - rpm] + 60_000 - now : 0);
}

/** Serializes starts for each account; active responses never hold a budget reservation. */
export class KiroAccountBudget {
    constructor({ now = Date.now, wait = (ms, signal) => sleep(ms, undefined, { signal }), maxEntries = 8192 } = {}) {
        this.now = now;
        this.wait = wait;
        this.maxEntries = maxEntries;
        this.accounts = new Map();
    }
    /** Read-only routing hint. Pending starts may still be waiting at the global gate. */
    getWaitMs(key, config = {}) {
        const limits = budgetLimits(config);
        if (!limits.interval && !limits.rpm) return 0;
        const state = this.accounts.get(key);
        if (!state) return 0;
        return state.pending ? Infinity : waitForBudget(state, limits, this.now());
    }
    async reserve(key, config = {}, signal, beforeStart) {
        signal?.throwIfAborted();
        const limits = budgetLimits(config);
        const { interval, rpm } = limits;
        if (!interval && !rpm) return await beforeStart?.();
        let state = this.accounts.get(key);
        if (!state) {
            for (const [candidate, entry] of this.accounts) {
                if (!entry.pending && this.now() - entry.last >= entry.retainMs) this.accounts.delete(candidate);
            }
            if (this.accounts.size >= this.maxEntries) throw Object.assign(new Error('Kiro account rate queue is full'), {
                status: 503, code: 'KIRO_BUDGET_QUEUE_FULL', skipErrorCount: true, shouldSwitchCredential: false
            });
            state = { queue: Promise.resolve(), starts: [], last: -Infinity, pending: 0, retainMs: 60_000 };
            this.accounts.set(key, state);
        }
        state.retainMs = Math.max(state.retainMs, interval, 60_000);
        state.pending++;
        const task = state.queue.then(async () => {
            signal?.throwIfAborted();
            while (true) {
                const now = this.now();
                state.starts = state.starts.filter(time => now - time < 60_000);
                const waitMs = waitForBudget(state, limits, now);
                if (waitMs <= 0) break;
                await this.wait(waitMs, signal);
                signal?.throwIfAborted();
            }
            // Reserve the global start only after this account is ready. Other
            // accounts remain free while this account waits for its own quota.
            await beforeStart?.();
            signal?.throwIfAborted();
            state.last = this.now();
            if (rpm) state.starts.push(state.last);
        });
        state.queue = task.catch(() => {}).finally(() => { state.pending--; });
        // A cancelled waiter returns immediately, even while another request is ahead.
        if (!signal) return task;
        let abort;
        try {
            return await Promise.race([task, new Promise((_, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
            })]);
        } finally { signal.removeEventListener('abort', abort); }
    }
}

export const kiroAccountBudget = new KiroAccountBudget();
