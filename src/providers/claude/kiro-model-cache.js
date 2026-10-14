/** Per-service, bounded metadata cache. Keys include authentication and proxy identity. */
export class KiroModelCache {
    constructor(limit = 16) { this.limit = limit; this.entries = new Map(); this.inflight = new Map(); }
    async get(key, loader, fallback, ttlMs = 300000) {
        const cached = this.entries.get(key);
        if (cached && cached.expires > Date.now()) {
            this.entries.delete(key); this.entries.set(key, cached);
            return structuredClone(cached.value);
        }
        if (!this.inflight.has(key)) {
            if (this.inflight.size >= this.limit) return structuredClone(fallback);
            const operation = (async () => {
                let value, ttl = ttlMs;
                try { value = await loader(); }
                catch { value = fallback; ttl = Math.min(ttlMs, 30000); }
                this.entries.set(key, { value, expires: Date.now() + ttl });
                while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
                return value;
            })();
            this.inflight.set(key, operation);
            operation.finally(() => this.inflight.delete(key)).catch(() => {});
        }
        return structuredClone(await this.inflight.get(key));
    }
}
