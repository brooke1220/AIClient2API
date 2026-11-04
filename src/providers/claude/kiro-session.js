import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
const digest = value => createHash('sha256').update(value).digest('hex');

/** Session identifiers are always hashed with the authenticated downstream scope. */
export function createKiroSessionContext(body = {}, scope = 'standalone') {
    let user = body.metadata?.user_id;
    if (typeof user === 'string' && user.length < 4096) {
        try { user = JSON.parse(user); } catch { /* Claude Code also sends user_…_session_UUID */ }
    }
    let session = body.metadata?.session_id || user?.session_id || body.session_id || body.conversation_id;
    if (!session && typeof user === 'string') session = user.match(/(?:^|_)session_([a-zA-Z0-9-]{8,128})(?:$|_)/)?.[1];
    if (typeof session !== 'string' || !session.trim() || session.length > 1024) session = null;
    if (!session) {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const contents = Array.isArray(body.contents) ? body.contents : [];
        const input = Array.isArray(body.input) ? body.input : [];
        const first = messages.find(item => item?.role === 'user') || contents.find(item => item?.role === 'user')
            || (Array.isArray(body.input) ? body.input.find(item => item?.role === 'user') : body.input);
        if (!first) return null;
        const systemMessages = [...messages, ...input].filter(item => ['system', 'developer'].includes(item?.role || item?.type));
        const system = body.system || body.instructions || body.systemInstruction || body.system_instruction || systemMessages;
        session = JSON.stringify([system, first]);
    }
    const hash = digest(JSON.stringify([scope, session]));
    return { key: hash, conversationId: uuidv5(hash, uuidv5.URL) };
}

export function kiroClientScope(req, authConfig = {}) {
    const headers = req?.headers || {};
    const url = new URL(req?.url || '/', 'http://localhost');
    // The auth layer has already accepted the request. Never persist raw keys.
    const bearer = typeof headers.authorization === 'string' ? headers.authorization.replace(/^Bearer\s+/i, '') : '';
    const candidates = [bearer, headers['x-api-key'], headers['x-goog-api-key'], url.searchParams.get('key')].filter(Boolean);
    const authenticated = authConfig.potluckApiKey || candidates.find(key => key === authConfig.REQUIRED_API_KEY);
    return digest(String(authenticated || candidates[0] || 'anonymous'));
}

/** Bounded, expiring bindings. Values are retained account-state objects, not rotating UUIDs. */
export class KiroSessionAffinity {
    constructor({ maxEntries = 8192, ttlMs = 60 * 60 * 1000 } = {}) {
        this.maxEntries = maxEntries;
        this.ttlMs = ttlMs;
        this.entries = new Map();
    }
    get(key, now = Date.now()) {
        const entry = this.entries.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= now) { this.entries.delete(key); return null; }
        return entry.state;
    }
    bind(key, state, now = Date.now()) {
        if (!key || !state) return;
        this.entries.delete(key);
        this.entries.set(key, { state, expiresAt: now + this.ttlMs });
        while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    }
}
