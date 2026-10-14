function requestError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    error.response = { status };
    error.skipErrorCount = true;
    return error;
}

export function validateKiroGenerationRequest(model, body) {
    if (typeof model !== 'string' || !model.trim()) throw requestError('Kiro model must be a nonempty string');
    const messages = body?.messages || body?.contents;
    if (!Array.isArray(messages) || !messages.length || messages.some(message => !message || typeof message !== 'object')) {
        throw requestError('Kiro requires a nonempty messages or contents array');
    }
}

export function buildKiroInferenceConfig(body, enabled = true) {
    const fields = [['max_tokens', 'maxTokens'], ['temperature', 'temperature'], ['top_p', 'topP']];
    const result = {};
    for (const [source, target] of fields) {
        if (body[source] === undefined || body[source] === null) continue;
        const value = body[source];
        const valid = typeof value === 'number' && Number.isFinite(value) &&
            (source === 'max_tokens' ? Number.isSafeInteger(value) && value > 0 : source === 'temperature' ? value >= 0 && value <= 1 : value >= 0 && value <= 1);
        if (!valid) throw requestError(`Invalid Kiro generation parameter: ${source}`);
        result[target] = value; // Presence, not truthiness: temperature=0 must survive.
    }
    return enabled && Object.keys(result).length ? result : undefined;
}

function byteSize(value) { return Buffer.byteLength(JSON.stringify(value)); }

function toolResultText(result) {
    return typeof result.content === 'string' ? result.content : (result.content || []).map(part => part.text || '').join('\n');
}

/**
 * Fold tool results that have no matching toolUses into plain message text.
 * Kiro rejects orphaned results, so a text fallback is the only lossless option;
 * it preserves failure status plus any image-association/omission notes.
 */
export function inlineOrphanToolResults(content, results) {
    let text = content || '';
    for (const result of results) {
        const body = toolResultText(result);
        if (!body) continue;
        const statusNote = result.status === 'error' ? ' (error)' : '';
        const note = `[Earlier tool result${statusNote} omitted from history]\n${body}`;
        text = text ? `${text}\n${note}` : note;
    }
    return text;
}

function repairTools(history, current) {
    const repair = (message, previous) => {
        const results = message?.userInputMessageContext?.toolResults;
        if (!results) return;
        const ids = new Set(previous?.assistantResponseMessage?.toolUses?.map(tool => tool.toolUseId) || []);
        const kept = [];
        const orphaned = [];
        for (const result of results) {
            if (ids.has(result.toolUseId)) kept.push(result);
            else orphaned.push(result);
        }
        if (orphaned.length) message.content = inlineOrphanToolResults(message.content, orphaned);
        if (kept.length) message.userInputMessageContext.toolResults = kept;
        else delete message.userInputMessageContext.toolResults;
    };
    history.forEach((entry, index) => repair(entry.userInputMessage, history[index - 1]));
    repair(current, history.at(-1));
}

/** Explicit opt-in trimming; never shorten the current user input or tool arguments. */
export function guardKiroPayload(payload, config = {}) {
    const configured = Number(config.KIRO_MAX_PAYLOAD_BYTES);
    const limit = Number.isFinite(configured) && configured > 0 ? configured : 10 * 1024 * 1024;
    let size = byteSize(payload);
    if (size <= limit) return payload;
    const state = payload.conversationState;
    const history = state?.history;
    if (config.KIRO_TRIM_HISTORY === true && history?.length) {
        // Work on copies: callers may reuse their own messages for a retry.
        const copy = JSON.parse(JSON.stringify(payload));
        const tail = copy.conversationState.history;
        const current = copy.conversationState.currentMessage?.userInputMessage;
        if (current) current.content = `[Some older conversation turns were omitted to fit the request budget.]\n${current.content || ''}`;
        // Preserve the priming/system pair and current active tool turn.
        while (tail.length > 4 && byteSize(copy) > limit) {
            tail.splice(2, 2);
        }
        repairTools(tail, copy.conversationState.currentMessage?.userInputMessage);
        size = byteSize(copy);
        if (size <= limit) return copy;
    }
    throw requestError(`Kiro request body exceeds the configured ${limit}-byte limit; shorten history or adjust KIRO_MAX_PAYLOAD_BYTES`, 413);
}
