import { createHash } from 'node:crypto';

/** Cache validated output only. In-flight work is shared without sharing caller cancellation. */
export class KiroImageCache {
    constructor({ maxEntries = 128, maxBytes = 32 * 1024 * 1024, ttlMs = 300000, maxInflight = 32, now = Date.now } = {}) {
        Object.assign(this, { maxEntries, maxBytes, ttlMs, maxInflight, now });
        this.entries = new Map();
        this.inflight = new Map();
        this.bytes = 0;
    }
    remove(key) {
        const entry = this.entries.get(key);
        if (entry) { clearTimeout(entry.timer); this.bytes -= entry.size; this.entries.delete(key); }
    }
    store(key, value) {
        const size = Buffer.byteLength(value.bytes) + Buffer.byteLength(value.format) + key.length;
        if (size > this.maxBytes || this.maxEntries <= 0 || this.ttlMs <= 0) return;
        this.remove(key);
        const entry = { value: Object.freeze({ ...value }), size, expiresAt: this.now() + this.ttlMs };
        entry.timer = setTimeout(() => { if (this.entries.get(key) === entry) this.remove(key); }, this.ttlMs);
        entry.timer.unref?.();
        this.entries.set(key, entry);
        this.bytes += size;
        while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.remove(this.entries.keys().next().value);
    }
    async get(key, loader, signal) {
        signal?.throwIfAborted();
        const now = this.now();
        for (const [entryKey, entry] of this.entries) if (entry.expiresAt <= now) this.remove(entryKey);
        const cached = this.entries.get(key);
        if (cached) {
            this.entries.delete(key); this.entries.set(key, cached);
            return cached.value;
        }
        let task = this.inflight.get(key);
        if (task?.controller.signal.aborted || !task && this.inflight.size >= this.maxInflight) {
            // Preserve the existing per-request serial path when the coalescing table is full.
            const value = await loader(signal);
            signal?.throwIfAborted();
            this.store(key, value);
            return value;
        }
        if (!task) {
            task = { controller: new AbortController(), waiters: 0, settled: false };
            const operation = task;
            task.promise = Promise.resolve().then(() => loader(operation.controller.signal)).finally(() => {
                operation.settled = true;
                if (this.inflight.get(key) === operation) this.inflight.delete(key);
            });
            this.inflight.set(key, task);
        }
        task.waiters++;
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                if (signal?.aborted) error = signal.reason || new Error('Image normalization aborted');
                signal?.removeEventListener('abort', onAbort);
                task.waiters--;
                if (!task.waiters && !task.settled) task.controller.abort();
                if (!error && !task.cached && !task.controller.signal.aborted) {
                    this.store(key, value);
                    task.cached = true;
                }
                if (error) reject(error); else resolve(value);
            };
            const onAbort = () => finish(signal.reason || new Error('Image normalization aborted'));
            signal?.addEventListener('abort', onAbort, { once: true });
            task.promise.then(value => finish(null, value), error => finish(error));
            if (signal?.aborted) onAbort();
        });
    }
    clear() {
        for (const key of this.entries.keys()) this.remove(key);
        for (const task of this.inflight.values()) task.controller.abort();
    }
}

export const kiroImageCache = new KiroImageCache();

let sharpModule;
async function imageProcessor() {
    sharpModule ||= import('sharp').then(module => module.default).catch(() => {
        sharpModule = null;
        throw Object.assign(new Error('Kiro image processor unavailable; install dependencies for the current platform'), {
            status: 503, code: 'KIRO_IMAGE_PROCESSOR_UNAVAILABLE', skipErrorCount: true, shouldSwitchCredential: false
        });
    });
    return sharpModule;
}

function imageError(message, status = 400) {
    return Object.assign(new Error(`Kiro image: ${message}`), {
        status, code: 'KIRO_IMAGE_INVALID', skipErrorCount: true, shouldSwitchCredential: false
    });
}
function positive(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function detectFormat(bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
    if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return null;
}

/** Decode only supported raster formats; bound both decompression and wire size. */
export async function normalizeKiroImages(payload, config = {}, signal) {
    const maxSource = positive(config.KIRO_IMAGE_MAX_SOURCE_BYTES, 10 * 1024 * 1024);
    const maxPixels = positive(config.KIRO_IMAGE_MAX_PIXELS, 40_000_000);
    const maxEdge = positive(config.KIRO_IMAGE_MAX_EDGE, 1568);
    const maxBase64 = positive(config.KIRO_IMAGE_MAX_BASE64_BYTES, 400_000);
    const messages = [...(payload.conversationState?.history || []), payload.conversationState?.currentMessage];
    for (const message of messages) for (const image of message?.userInputMessage?.images || []) {
        signal?.throwIfAborted();
        const encoded = image.source?.bytes;
        if (typeof encoded !== 'string' || encoded.length > Math.ceil(maxSource / 3) * 4 + 4) {
            throw imageError('source exceeds the configured byte limit', 413);
        }
        // Buffer.from is deliberately forgiving; reject junk instead of silently changing it.
        if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw imageError('invalid base64 data');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length > maxSource) throw imageError('source exceeds the configured byte limit', 413);
        const format = detectFormat(bytes);
        if (!format) throw imageError('unsupported or unrecognized raster format');
        // Every source still passes byte/base64/format validation before a lookup.
        // Pixel and complete-decode validation is reusable only for identical content and limits.
        const key = createHash('sha256').update(bytes).update(JSON.stringify([maxSource, maxPixels, maxEdge, maxBase64])).digest('hex');
        const normalized = await kiroImageCache.get(key, async operationSignal => {
            const sharp = await imageProcessor();
            operationSignal?.throwIfAborted();
            try {
                // 'error' rejects truncated/corrupt data but accepts recoverable decoder warnings.
                const metadata = await sharp(bytes, { limitInputPixels: maxPixels, failOn: 'error' }).metadata();
                if (!metadata.width || !metadata.height || metadata.format !== format) throw imageError('invalid image dimensions or format');
                // Decode even small images so truncated/corrupt bodies do not reach upstream.
                const oriented = sharp(bytes, { limitInputPixels: maxPixels, failOn: 'error' }).rotate();
                const canonical = bytes.toString('base64');
                if (Math.max(metadata.width, metadata.height) <= maxEdge && canonical.length <= maxBase64) {
                    await oriented.stats();
                    operationSignal?.throwIfAborted();
                    return { format, bytes: canonical };
                }
                let edge = Math.min(maxEdge, Math.max(metadata.width, metadata.height));
                let result;
                for (let attempt = 0; attempt < 10; attempt++) {
                    operationSignal?.throwIfAborted();
                    result = await oriented.clone().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
                        .flatten({ background: '#ffffff' }).jpeg({ quality: Math.max(45, 85 - attempt * 10) }).toBuffer();
                    if (Math.ceil(result.length / 3) * 4 <= maxBase64) break;
                    result = null;
                    edge = Math.max(1, Math.floor(edge * 0.7));
                }
                if (!result) throw imageError('cannot fit image into the configured output limit', 413);
                operationSignal?.throwIfAborted();
                return { format: 'jpeg', bytes: result.toString('base64') };
            } catch (error) {
                operationSignal?.throwIfAborted();
                if (error.code === 'KIRO_IMAGE_INVALID') throw error;
                throw imageError('corrupt image or configured pixel limit exceeded');
            }
        }, signal);
        signal?.throwIfAborted();
        image.format = normalized.format;
        image.source = { bytes: normalized.bytes };
    }
    signal?.throwIfAborted();
    return payload;
}
