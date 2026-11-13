import { Worker } from 'node:worker_threads';
import logger from './logger.js';
import { approximateTextTokens, prepareInputTokenCount } from './token-utils.js';

const unavailable = () => Object.assign(new Error('Background token counter unavailable'), { code: 'TOKEN_COUNTER_UNAVAILABLE' });
const createCounterWorker = () => new Worker(new URL('./token-counter-worker.js', import.meta.url), {
    // This flag is valid only for the parent's eval/stdin entry point. A worker
    // always starts from the file URL above and must not inherit it.
    execArgv: process.execArgv.filter((arg, index, args) => arg !== '--input-type'
        && !arg.startsWith('--input-type=') && args[index - 1] !== '--input-type')
});

/** One persistent encoder, with bounds covering both queued and active text. */
export class TokenCounter {
    constructor({ maxTasks = 32, maxChars = 32 * 1024 * 1024, timeoutMs = 15000,
        createWorker = createCounterWorker } = {}) {
        this.maxTasks = maxTasks;
        this.maxChars = maxChars;
        this.timeoutMs = timeoutMs;
        this.createWorker = createWorker;
        this.queue = [];
        this.active = null;
        this.chars = 0;
        this.sequence = 0;
        this.worker = null;
        this.closed = false;
    }

    _ensureWorker() {
        if (this.worker) return this.worker;
        const worker = this.createWorker();
        this.worker = worker;
        worker.on('message', message => {
            if (worker !== this.worker || message.type === 'ready') return;
            const task = this.active;
            if (!task || message.id !== task.id) return;
            this.active = null;
            this._settle(task, message.error || !Number.isSafeInteger(message.count) || message.count < 0 ? unavailable() : null, message.count);
            this._pump();
        });
        worker.on('error', () => this._failWorker(worker));
        worker.on('exit', () => this._failWorker(worker));
        worker.unref();
        return worker;
    }

    warmup() {
        if (!this.closed) this._ensureWorker();
    }

    count(texts, { signal } = {}) {
        if (signal?.aborted) return Promise.reject(signal.reason || new Error('Token counting cancelled'));
        if (this.closed) return Promise.reject(unavailable());
        const chars = texts.reduce((sum, text) => sum + text.length, 0);
        if (this.queue.length + (this.active ? 1 : 0) >= this.maxTasks || chars + this.chars > this.maxChars) {
            return Promise.reject(unavailable());
        }
        return new Promise((resolve, reject) => {
            const task = { id: ++this.sequence, texts, chars, signal, resolve, reject };
            task.abort = () => {
                if (this.active === task) {
                    this.active = null;
                    const worker = this.worker;
                    this.worker = null;
                    void worker?.terminate();
                } else {
                    const index = this.queue.indexOf(task);
                    if (index < 0) return;
                    this.queue.splice(index, 1);
                }
                this._settle(task, signal.reason || new Error('Token counting cancelled'));
                this._pump();
            };
            this.chars += chars;
            this.queue.push(task);
            signal?.addEventListener('abort', task.abort, { once: true });
            if (signal?.aborted) task.abort(); else this._pump();
        });
    }

    _settle(task, error, count) {
        clearTimeout(task.timer);
        task.signal?.removeEventListener('abort', task.abort);
        this.chars -= task.chars;
        task.texts = null;
        if (error) task.reject(error); else task.resolve(count);
    }

    _pump() {
        if (this.closed || this.active) return;
        const task = this.queue.shift();
        if (!task) { this.worker?.unref(); return; }
        this.active = task;
        try {
            const worker = this._ensureWorker();
            worker.ref();
            task.timer = setTimeout(() => this._failWorker(worker), this.timeoutMs);
            worker.postMessage({ id: task.id, texts: task.texts });
        } catch {
            const worker = this.worker;
            if (worker) this._failWorker(worker);
            else {
                this.active = null;
                this._settle(task, unavailable());
                this._pump();
            }
        }
    }

    _failWorker(worker) {
        if (worker !== this.worker) return;
        this.worker = null;
        void worker.terminate();
        if (this.active) {
            const task = this.active;
            this.active = null;
            this._settle(task, unavailable());
        }
        this._pump();
    }

    async dispose() {
        this.closed = true;
        const worker = this.worker;
        this.worker = null;
        const tasks = [...(this.active ? [this.active] : []), ...this.queue];
        this.active = null;
        this.queue = [];
        for (const task of tasks) this._settle(task, unavailable());
        await worker?.terminate();
    }
}

let sharedCounter;
let lastFallbackLog = -Infinity;
const counter = () => sharedCounter ||= new TokenCounter();

export function warmupTokenCounter() {
    try { counter().warmup(); } catch { /* A later request can retry worker startup. */ }
}

export async function disposeTokenCounter() {
    const previous = sharedCounter;
    sharedCounter = undefined;
    await previous?.dispose();
}

export async function countTextsTokensAsync(texts, options = {}) {
    options.signal?.throwIfAborted();
    if (!texts.some(text => text.length)) return 0;
    try {
        return await counter().count(texts, options);
    } catch (error) {
        options.signal?.throwIfAborted();
        // The existing local estimate remains available if threads cannot run
        // or the bounded queue is full; never fall back to synchronous encoding.
        if (Date.now() - lastFallbackLog >= 5000) {
            lastFallbackLog = Date.now();
            logger.warn('[TokenUtils] Background counter unavailable; using local length estimate');
        }
        return texts.reduce((sum, text) => sum + approximateTextTokens(text), 0);
    }
}

export async function estimateInputTokensAsync(requestBody, options = {}) {
    options.signal?.throwIfAborted();
    const { text, extraTokens } = prepareInputTokenCount(requestBody);
    return await countTextsTokensAsync([text], options) + extraTokens;
}
