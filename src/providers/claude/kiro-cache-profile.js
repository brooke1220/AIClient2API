import { createHash } from 'node:crypto';
import { countTextTokens, ESTIMATED_IMAGE_TOKENS } from '../../utils/token-utils.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const frame = value => { const text = JSON.stringify(value); return `${Buffer.byteLength(text)}:${text}`; };
const sourceKey = message => {
    // Runtime routing can change only current-message origin after conversion.
    const { origin, ...content } = message;
    return hash(JSON.stringify(content));
};

/** Capture after image conversion, before trimming. Changed/repaired entries
 * deliberately lose their mapping rather than inheriting a broader breakpoint. */
export function captureKiroCacheSources(sources, request) {
    const messages = new Map();
    for (const { wire, ...source } of sources || []) {
        const key = sourceKey(wire);
        messages.set(key, messages.has(key) ? null : source);
    }
    const declarations = [request.cache_control];
    for (const tool of request.tools || []) declarations.push(tool?.cache_control);
    for (const block of Array.isArray(request.system) ? request.system : []) declarations.push(block?.cache_control);
    for (const message of request.messages || []) {
        for (const block of Array.isArray(message.content) ? message.content : []) declarations.push(block?.cache_control);
    }
    return { messages, declarations: declarations.filter(value => value !== undefined),
        automatic: request.cache_control, tools: (request.tools || []).filter(tool => !/^web_?search$/i.test(tool?.name || '')) };
}

function ttlOf(control, defaultTtl) {
    if (!control || typeof control !== 'object' || Array.isArray(control) || control.type !== 'ephemeral') return null;
    if (control.ttl === '1h') return 3600000;
    if (control.ttl === '5m') return 300000;
    return control.ttl === undefined ? defaultTtl : null;
}

export function kiroCacheMinTokens(model, config = {}) {
    const table = config.KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL;
    const override = table && typeof table === 'object' && !Array.isArray(table) ? table[model] : undefined;
    if (Number.isSafeInteger(override) && override > 0) return override;
    // Conservative estimator defaults, not an assertion about Kiro's backend.
    return /sonnet/i.test(model) ? 1024 : 4096;
}

function sourceTextParts(content) {
    return typeof content === 'string' ? [{ type: 'text', text: content }]
        : Array.isArray(content) ? content : [];
}

/** Fingerprints contain upstream content, including image bytes and tool IDs.
 * Neither hashes nor token totals include cache_control or transport headers. */
export function buildKiroCacheProfile(payload, sourceInfo, config = {}, count = countTextTokens) {
    const state = payload?.conversationState;
    const current = state?.currentMessage?.userInputMessage;
    const model = current?.modelId || '';
    const policyOption = ['explicit', 'history'].includes(config.KIRO_PROMPT_CACHE_POLICY) ? config.KIRO_PROMPT_CACHE_POLICY : 'auto';
    const declared = sourceInfo?.declarations || [];
    const policy = policyOption === 'auto' ? (declared.length ? 'explicit' : 'history') : policyOption;
    const configuredTtl = Number(config.KIRO_PROMPT_CACHE_DEFAULT_TTL_MS ?? 300000);
    const defaultTtl = Number.isSafeInteger(configuredTtl) && configuredTtl > 0
        ? Math.min(configuredTtl, 3600000) : 300000;
    const profile = { policy, blocks: [], breakpoints: [], total: 0, reason: null,
        namespace: hash(JSON.stringify(['kiro-prompt-v1', model, state?.conversationId, current?.origin,
            payload?.additionalModelRequestFields || null])) };
    if (!state || !current || !model) return { ...profile, reason: 'missing_payload' };
    const minimum = kiroCacheMinTokens(model, config);
    let hasher = createHash('sha256');
    const explicit = [];
    const implicit = [];
    let unmapped = false;
    const addPoint = (index, control) => {
        if (control !== undefined) explicit.push({ index, ttlMs: ttlOf(control, defaultTtl) });
    };
    const addBlock = (digest, tokens, group = null) => {
        profile.total += Math.max(0, Math.floor(tokens));
        profile.blocks.push({ hash: digest, tokens: profile.total, group });
        return profile.blocks.length - 1;
    };
    const atomic = (kind, value, control, group) => {
        hasher.update(frame([kind, value]));
        const tokens = kind === 'image' ? ESTIMATED_IMAGE_TOKENS : count(JSON.stringify(value));
        const index = addBlock(hasher.copy().digest('hex'), tokens, group);
        addPoint(index, control);
        return index;
    };

    const wireTools = current.userInputMessageContext?.tools || [];
    let toolIndex = 0;
    for (const tool of wireTools) {
        if (!tool.toolSpecification) continue; // cachePoint is a declaration, not prompt text
        const source = sourceInfo?.tools?.[toolIndex++];
        atomic('tool', tool.toolSpecification, source?.cache_control);
    }
    if (profile.blocks.length) implicit.push({ index: profile.blocks.length - 1, ttlMs: defaultTtl });

    const entries = [...(state.history || []), { userInputMessage: current }];
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
        const entry = entries[entryIndex];
        const role = entry.userInputMessage ? 'user' : 'assistant';
        const message = entry.userInputMessage || entry.assistantResponseMessage;
        if (!message) continue;
        const source = sourceInfo?.messages?.get(sourceKey(message));
        const text = typeof message.content === 'string' ? message.content : '';
        hasher.update(frame([role, message.modelId || model, message.origin || null]));
        const ends = new Map();
        const locate = (content, start, limit = text.length) => {
            let cursor = start;
            for (const part of sourceTextParts(content)) {
                const value = part?.type === 'text' ? part.text : part?.type === 'thinking' ? part.thinking : null;
                if (typeof value !== 'string' || !value.length) continue;
                const found = text.indexOf(value, cursor);
                if (found < cursor || found + value.length > limit) {
                    if (part.cache_control !== undefined) unmapped = true;
                    continue;
                }
                cursor = found + value.length;
                if (ends.has(cursor) && part.cache_control !== undefined) unmapped = true;
                // Thinking can participate in a prefix but cannot declare one.
                if (part.type === 'thinking' && part.cache_control !== undefined) unmapped = true;
                ends.set(cursor, part.type === 'thinking' ? undefined : part.cache_control);
            }
        };
        const systemEnd = source?.systemPrefixLength || 0;
        if (source) {
            if (systemEnd) locate(source.system, 0, systemEnd);
            locate(source.content, systemEnd);
        }
        if (systemEnd && systemEnd <= text.length && !ends.has(systemEnd)) ends.set(systemEnd, undefined);
        if (text.length && !ends.has(text.length)) ends.set(text.length, undefined);
        const textHasher = hasher.copy().update(frame('text'));
        let previousEnd = 0;
        let previousHashEnd = 0;
        for (const [end, control] of [...ends].sort((a, b) => a[0] - b[0])) {
            // Hash each byte once. A source boundary can split a surrogate
            // pair; retain that high surrogate until its low half arrives,
            // while the partial endpoint uses UTF-8's replacement character.
            const splitPair = end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] || '')
                && /[\uDC00-\uDFFF]/.test(text[end]);
            const hashEnd = splitPair ? end - 1 : end;
            textHasher.update(text.slice(previousHashEnd, hashEnd));
            const checkpoint = textHasher.copy();
            if (splitPair) checkpoint.update('\uFFFD');
            const index = addBlock(checkpoint.digest('hex'), count(text.slice(previousEnd, end)));
            addPoint(index, control);
            if (end === systemEnd) implicit.push({ index, ttlMs: defaultTtl });
            previousEnd = end;
            previousHashEnd = hashEnd;
        }
        // Prefix hashes are independent of where the client places its marks:
        // splitting one text into smaller blocks does not change later hashes.
        // Frame the completed text by length so prompt text cannot imitate
        // structural delimiters between messages or non-text content.
        hasher.update(frame(['text', text]));
        const parts = sourceTextParts(source?.content);
        const imageParts = parts.filter(part => ['image', 'image_url'].includes(part?.type));
        const images = message.images || [];
        for (let i = 0; i < images.length; i++) {
            const control = imageParts.length === images.length ? imageParts[i]?.cache_control : undefined;
            atomic('image', images[i], control);
        }
        if (imageParts.length !== images.length && imageParts.some(part => part.cache_control !== undefined)) unmapped = true;
        for (const [kind, values, sourceType, idField] of [
            ['tool_use', message.toolUses || [], 'tool_use', 'id'],
            ['tool_result', message.userInputMessageContext?.toolResults || [], 'tool_result', 'tool_use_id']
        ]) {
            for (const value of values) {
                const part = parts.find(item => item?.type === sourceType && item[idField] === value.toolUseId);
                atomic(kind, value, part?.cache_control, `${entryIndex}:${kind}`);
            }
        }
        // A marked non-text block that was dropped or inlined is not safely
        // mappable. Refuse to expand its mark to the whole surviving message.
        for (const part of parts) {
            if (part?.cache_control === undefined || part.type === 'text') continue;
            if (part.type === 'tool_use' && !message.toolUses?.some(value => value.toolUseId === part.id)
                || part.type === 'tool_result' && !message.userInputMessageContext?.toolResults?.some(value => value.toolUseId === part.tool_use_id)
                || !['image', 'image_url', 'tool_use', 'tool_result'].includes(part.type)) unmapped = true;
        }
        if (entryIndex < entries.length - 1 && profile.blocks.length) {
            implicit.push({ index: profile.blocks.length - 1, ttlMs: defaultTtl });
        }
        hasher.update(frame('end_message'));
    }
    if (policy === 'history') {
        profile.breakpoints = implicit.filter(point => profile.blocks[point.index].tokens >= minimum);
    } else {
        let reusedAutomatic = false;
        if (sourceInfo?.automatic !== undefined && profile.blocks.length) {
            const index = profile.blocks.length - 1;
            // An explicit mark at the same endpoint already occupies this slot.
            if (!explicit.some(point => point.index === index)) addPoint(index, sourceInfo.automatic);
            else reusedAutomatic = true;
        }
        if (declared.some(value => ttlOf(value, defaultTtl) === null) || explicit.some(point => point.ttlMs === null)) {
            profile.reason = 'invalid_cache_control';
        } else if (declared.length > 4 || explicit.length > 4) {
            profile.reason = 'too_many_breakpoints';
        } else if (unmapped || explicit.length < declared.length - (reusedAutomatic ? 1 : 0)) {
            profile.reason = 'unmapped_breakpoint';
        } else {
            const sorted = explicit.sort((a, b) => a.index - b.index);
            let shortSeen = false;
            for (const point of sorted) {
                if (shortSeen && point.ttlMs > 300000) profile.reason = 'invalid_ttl_order';
                if (point.ttlMs <= 300000) shortSeen = true;
            }
            if (!profile.reason) profile.breakpoints = sorted.filter(point => profile.blocks[point.index].tokens >= minimum);
        }
    }
    profile.breakpoints = profile.breakpoints.filter((point, index, list) => index === 0 || point.index !== list[index - 1].index);
    if (!profile.breakpoints.length && !profile.reason) profile.reason = declared.length || implicit.length ? 'below_minimum' : 'no_reusable_prefix';
    return profile;
}
