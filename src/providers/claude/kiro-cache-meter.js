import { createHash } from 'node:crypto';
import { buildKiroCacheProfile } from './kiro-cache-profile.js';

const digest = value => createHash('sha256').update(value).digest('hex');

export function kiroCacheMode(config = {}) {
    return ['observe', 'estimate'].includes(config.KIRO_PROMPT_CACHE_MODE) ? config.KIRO_PROMPT_CACHE_MODE : 'off';
}

export function kiroCacheCapacity(config = {}) {
    const value = Number(config.KIRO_PROMPT_CACHE_MAX_ENTRIES ?? 65536);
    return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1048576) : 65536;
}

/** Stable account identity; a rotating access token is deliberately excluded. */
export function kiroCacheAccountScope(service) {
    return digest(JSON.stringify([
        service.config?.KIRO_OAUTH_CREDS_FILE_PATH || service.credsFilePath || service.uuid || 'standalone',
        service.config?.KIRO_API_KEY || service.apiKey || '', service.profileArn || ''
    ]));
}

/** Only committed prefixes are visible. prepare() never warms or renews an entry. */
export class KiroCacheMeter {
    constructor({ now = Date.now } = {}) {
        this.now = now;
        this.entries = new Map();
    }

    prepare(profile, scope, { capacity = 65536 } = {}) {
        const startedAt = this.now();
        const entries = this.entries;
        // Opportunistic bounded cleanup, including reads: expired entries must
        // not consume the entire store when no new prefixes are being written.
        let swept = 0;
        for (const [key, entry] of entries) {
            if (entry.expiresAt <= startedAt) entries.delete(key);
            if (++swept >= 64) break;
        }
        const prefix = digest(JSON.stringify([scope, profile.namespace]));
        const keyFor = block => `${prefix}:${block.hash}`;
        const hits = new Map();
        let read = 0;
        for (const breakpoint of profile.breakpoints) {
            let positions = 0;
            let group;
            for (let i = breakpoint.index; i >= 0; i--) {
                const block = profile.blocks[i];
                if (!block.group || block.group !== group) positions++;
                if (positions > 20) break;
                group = block.group;
                const key = keyFor(block);
                const entry = entries.get(key);
                if (entry && entry.expiresAt > startedAt) {
                    read = Math.max(read, Math.min(block.tokens, entry.tokens));
                    hits.set(key, entry);
                    break;
                }
            }
        }
        const covered = profile.breakpoints.length
            ? profile.blocks[profile.breakpoints.at(-1).index].tokens : 0;
        let committed = false;
        return {
            policy: profile.policy, reason: profile.reason, total: profile.total,
            covered, read: Math.min(read, covered),
            creationTiers: profile.breakpoints.map(bp => ({ tokens: profile.blocks[bp.index].tokens, ttlMs: bp.ttlMs })),
            commit: () => {
                if (committed) return;
                committed = true;
                const now = this.now();
                // Expiry is anchored at dispatch, not at the end of a long
                // generation. A replaced entry must not be overwritten by an
                // older, slower request's renewal.
                for (const [key, entry] of hits) {
                    const current = entries.get(key);
                    if (current === entry && startedAt + entry.ttlMs > now) {
                        entries.delete(key);
                        entries.set(key, { ...entry, expiresAt: Math.max(entry.expiresAt, startedAt + entry.ttlMs) });
                    }
                }
                for (const bp of profile.breakpoints) {
                    const expiresAt = startedAt + bp.ttlMs;
                    if (expiresAt <= now) continue;
                    const block = profile.blocks[bp.index];
                    const key = keyFor(block);
                    const previous = entries.get(key);
                    if (previous && previous.expiresAt > expiresAt) continue;
                    entries.delete(key);
                    entries.set(key, { tokens: block.tokens, ttlMs: bp.ttlMs, expiresAt });
                }
                while (entries.size > capacity) entries.delete(entries.keys().next().value);
            }
        };
    }

    clear() { this.entries.clear(); }
}

export const kiroCacheMeter = new KiroCacheMeter();

export function prepareKiroCacheAttempt(service, routedConfig, sourceInfo, sessionKey) {
    if (kiroCacheMode(service.config) === 'off' || !sourceInfo) return null;
    const profile = buildKiroCacheProfile(routedConfig.data, sourceInfo, service.config);
    return kiroCacheMeter.prepare(profile, [kiroCacheAccountScope(service), sessionKey || sourceInfo.sessionKey,
        routedConfig.url], { capacity: kiroCacheCapacity(service.config) });
}
