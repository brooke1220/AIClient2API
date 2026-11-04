import { KIRO_USAGE_DETAILS } from '../providers/claude/kiro-cache-usage.js';

const number = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const has = (object, key) => object != null && Object.hasOwn(object, key);

export function emptyNormalizedUsage() {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 };
}

/** Normalize protocol semantics before merging: Anthropic's input is net,
 * whereas OpenAI's input already contains cached reads and writes. */
export function normalizeUsageCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    if (Array.isArray(candidate)) return candidate.reduce((usage, item) => mergeNormalizedUsage(usage, normalizeUsageCandidate(item)), emptyNormalizedUsage());
    const usage = candidate.usage || candidate.message?.usage || candidate.usageMetadata || candidate.response?.usage;
    if (!usage && !['prompt_tokens', 'input_tokens', 'total_tokens', 'completion_tokens', 'output_tokens',
        'promptTokenCount', 'inputTokenCount', 'candidatesTokenCount', 'outputTokenCount', 'totalTokenCount',
        'cached_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].some(key => has(candidate, key))) return null;
    const value = usage || candidate;
    const details = value[KIRO_USAGE_DETAILS];
    const anthropic = has(value, 'cache_read_input_tokens') || has(value, 'cache_creation_input_tokens');
    const read = number(value.cached_tokens ?? value.prompt_tokens_details?.cached_tokens
        ?? value.input_tokens_details?.cached_tokens ?? value.cache_read_input_tokens ?? value.cachedContentTokenCount);
    const creation = number(value.cache_creation_input_tokens);
    // Some Claude-format chunks also carry OpenAI totals; their net input_tokens wins.
    const input = number((anthropic ? value.input_tokens ?? value.prompt_tokens : value.prompt_tokens ?? value.input_tokens)
        ?? value.promptTokenCount ?? value.inputTokenCount);
    const promptTokens = input + (anthropic ? read + creation : 0);
    const completionTokens = number(value.completion_tokens ?? value.output_tokens ?? value.candidatesTokenCount ?? value.outputTokenCount)
        + number(value.thoughtsTokenCount); // Gemini reports thoughts separately; OpenAI's total output already includes them.
    const cacheReadSource = details?.sources?.cache_read_input_tokens
        || (has(value, 'cached_tokens') || has(value, 'cache_read_input_tokens') || has(value, 'cachedContentTokenCount')
            || has(value.prompt_tokens_details, 'cached_tokens') || has(value.input_tokens_details, 'cached_tokens') ? 'provider' : 'unavailable');
    const cacheCreationSource = details?.sources?.cache_creation_input_tokens
        || (has(value, 'cache_creation_input_tokens') ? 'provider' : 'unavailable');
    const sourceSet = new Set([cacheReadSource, cacheCreationSource]);
    const cacheSource = sourceSet.has('estimated') ? sourceSet.has('provider') ? 'mixed' : 'estimated'
        : sourceSet.has('provider') ? 'provider' : 'unavailable';
    const fullAnthropic = anthropic && has(value, 'input_tokens') && has(value, 'output_tokens')
        && has(value, 'cache_read_input_tokens') && has(value, 'cache_creation_input_tokens');
    const final = details?.stage === 'final' || fullAnthropic && (candidate.type === 'message_delta' || candidate.type === 'message');
    return { promptTokens, completionTokens, totalTokens: number(value.total_tokens ?? value.totalTokenCount) || promptTokens + completionTokens,
        cachedTokens: read, cacheCreationTokens: creation, cacheReadSource, cacheCreationSource, cacheSource,
        _snapshotPriority: final ? details ? 3 : 2 : 0 };
}

/** A final snapshot replaces provisional estimates atomically, including
 * downward corrections and explicit zeros. Later converted copies cannot
 * erase the native snapshot's richer provenance. */
export function mergeNormalizedUsage(base = emptyNormalizedUsage(), next) {
    if (!next) return base;
    if (next._snapshotPriority) return (base._snapshotPriority || 0) > next._snapshotPriority ? base : { ...next };
    if (base._snapshotPriority) return base;
    const promptTokens = Math.max(base.promptTokens || 0, next.promptTokens || 0);
    const completionTokens = Math.max(base.completionTokens || 0, next.completionTokens || 0);
    return { ...base,
        promptTokens, completionTokens,
        totalTokens: Math.max(base.totalTokens || 0, next.totalTokens || 0, promptTokens + completionTokens),
        cachedTokens: Math.max(base.cachedTokens || 0, next.cachedTokens || 0),
        cacheCreationTokens: Math.max(base.cacheCreationTokens || 0, next.cacheCreationTokens || 0),
        cacheReadSource: next.cacheReadSource === 'unavailable' && base.cacheReadSource ? base.cacheReadSource : next.cacheReadSource || base.cacheReadSource,
        cacheCreationSource: next.cacheCreationSource === 'unavailable' && base.cacheCreationSource ? base.cacheCreationSource : next.cacheCreationSource || base.cacheCreationSource,
        cacheSource: next.cacheSource === 'unavailable' && base.cacheSource ? base.cacheSource : next.cacheSource || base.cacheSource
    };
}

export function extractNormalizedUsage(...candidates) {
    return candidates.reduce((usage, candidate) => mergeNormalizedUsage(usage, normalizeUsageCandidate(candidate)), emptyNormalizedUsage());
}
