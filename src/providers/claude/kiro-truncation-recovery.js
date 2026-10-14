import { createHash } from 'node:crypto';

export const KIRO_TRUNCATION_NOTICE = '[Gateway truncation notice] The preceding assistant text was observed ending with max_tokens; it may be incomplete. Continue from the unfinished point only if the current user request calls for it, without repeating completed text. Do not assume a tool ran or replay earlier tool calls; use actual tool results to determine execution status.';

function stableJSON(value) {
    return JSON.stringify(value, (_key, item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const sorted = Object.create(null);
        for (const key of Object.keys(item).sort()) sorted[key] = item[key];
        return sorted;
    });
}

function canonicalContent(content) {
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (!Array.isArray(blocks)) return blocks ?? null;
    const result = [];
    for (const block of blocks) {
        if (block?.type === 'thinking' || block?.type === 'redacted_thinking') continue;
        const normalized = typeof block === 'string' ? { type: 'text', text: block } : block;
        if (normalized?.type === 'text') {
            const text = normalized.text || '';
            if (result.at(-1)?.type === 'text') result.at(-1).text += text;
            else result.push({ type: 'text', text });
        } else if (normalized && typeof normalized === 'object') {
            const { cache_control: _cacheControl, ...data } = normalized;
            result.push(data);
        } else result.push(normalized);
    }
    return result;
}

function requestFingerprint(model, body, messages) {
    return createHash('sha256').update(stableJSON({
        model,
        system: canonicalContent(body.system),
        tools: Array.isArray(body.tools) ? body.tools.map(({ cache_control: _cacheControl, ...tool }) => tool) : body.tools ?? null,
        // A caller-provided session/user scope is useful in addition to the full history.
        user: body.metadata?.user_id ?? body.user ?? null,
        messages: messages.map(message => ({ role: message.role, content: canonicalContent(message.content) }))
    })).digest('hex');
}

function assistantText(message) {
    const content = canonicalContent(message.content);
    if (!Array.isArray(content) || content.some(block => block?.type !== 'text')) return null;
    return content.map(block => block.text).join('');
}

// Hash UTF-16 fragments as one UTF-8 string, including split surrogate pairs.
class TextFingerprint {
    constructor() { this.hash = createHash('sha256'); this.pending = ''; this.hasVisibleText = false; }
    update(text) {
        this.hasVisibleText ||= /\S/.test(text);
        let value = this.pending + text;
        this.pending = '';
        const last = value.charCodeAt(value.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) { this.pending = value.at(-1); value = value.slice(0, -1); }
        this.hash.update(value);
    }
    digest() { return this.hash.update(this.pending).digest('hex'); }
}

/** Per-service, bounded, short-lived digests only: no response text or tool arguments. */
export class KiroTruncationRecovery {
    constructor({ limit = 64, ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
        this.limit = Number.isSafeInteger(limit) && limit > 0 ? limit : 64;
        this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 10 * 60 * 1000;
        this.now = typeof now === 'function' ? now : () => Date.now();
        this.entries = new Map();
    }
    prune() {
        const now = this.now();
        for (const [key, expires] of this.entries) if (expires <= now) this.entries.delete(key);
    }
    observe(model, body) {
        const messages = body.messages || body.contents;
        if (!Array.isArray(messages)) return null;
        const text = new TextFingerprint();
        let hasTools = false, stopReason = null, finished = false;
        return {
            accept: event => {
                if (finished) return;
                if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') hasTools = true;
                if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') text.update(event.delta.text);
                if (event.type === 'message_delta') stopReason = event.delta?.stop_reason;
                if (event.type !== 'message_stop') return;
                finished = true;
                // Never infer completion/truncation from an EOF, network failure,
                // thinking-only fallback, or malformed/unexecuted tool arguments.
                const normalCompletion = stopReason === 'end_turn' || stopReason === 'stop_sequence';
                if ((!normalCompletion && stopReason !== 'max_tokens') || hasTools || !text.hasVisibleText) return;
                this.prune();
                if (normalCompletion && !this.entries.size) return;
                // Hash only at the terminal boundary, never on the first-token
                // path. A successful retry invalidates the exact old digest;
                // unrelated sessions/output branches retain their evidence.
                const prefix = requestFingerprint(model, body, messages);
                const key = `${prefix}:${text.digest()}`;
                this.entries.delete(key);
                if (normalCompletion) return;
                this.entries.set(key, this.now() + this.ttlMs);
                while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
            }
        };
    }
    getNotice(model, body) {
        this.prune();
        if (!this.entries.size) return '';
        const messages = body.messages || body.contents;
        if (!Array.isArray(messages) || messages.at(-1)?.role !== 'user') return '';
        let index = messages.length - 2;
        while (index >= 0 && messages[index].role !== 'assistant') index--;
        if (index < 0) return '';
        const text = assistantText(messages[index]);
        if (!text?.trim()) return '';
        const prefix = requestFingerprint(model, body, messages.slice(0, index));
        const key = `${prefix}:${createHash('sha256').update(text).digest('hex')}`;
        return this.entries.has(key) ? KIRO_TRUNCATION_NOTICE : '';
    }
}
