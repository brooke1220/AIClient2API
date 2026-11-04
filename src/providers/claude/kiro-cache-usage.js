// Internal provenance never becomes a non-standard field on the public API.
export const KIRO_USAGE_DETAILS = Symbol.for('aiclient2api.kiro.usage-details');
const valid = value => Number.isSafeInteger(value) && value >= 0;
const integer = value => Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(value)) : 0;

export function attachKiroUsageDetails(usage, details) {
    Object.defineProperty(usage, KIRO_USAGE_DETAILS, { value: details, configurable: true });
    return usage;
}

export function copyKiroUsageDetails(source, target, overrides = {}) {
    if (source?.[KIRO_USAGE_DETAILS]) attachKiroUsageDetails(target, { ...source[KIRO_USAGE_DETAILS], ...overrides });
    return target;
}

export function splitKiroCacheUsage(totalInput, plan) {
    const total = integer(totalInput);
    if (!plan?.total || !plan.covered) return { input: total, read: 0, creation: 0, fiveMinute: 0, oneHour: 0 };
    const covered = Math.min(total, Math.round(total * Math.min(1, plan.covered / plan.total)));
    const read = Math.min(covered, Math.max(0, Math.round(covered * plan.read / plan.covered)));
    const creation = covered - read;
    let previous = plan.read;
    let longCreation = 0;
    for (const tier of plan.creationTiers || []) {
        const delta = Math.max(0, tier.tokens - previous);
        if (tier.ttlMs > 300000) longCreation += delta;
        previous = Math.max(previous, tier.tokens);
    }
    const estimatedCreation = plan.covered - plan.read;
    const oneHour = estimatedCreation > 0 ? Math.min(creation, Math.round(creation * longCreation / estimatedCreation)) : 0;
    return { input: total - covered, read, creation, fiveMinute: creation - oneHour, oneHour };
}

/** Preserve every known provider field, including zero. Estimate only the
 * remaining room in one input total; conflicting estimates never win. */
export function resolveKiroCacheUsage({ inputTokens, outputTokens, nativeUsage, metering, plan, mode = 'off',
    totalSource = 'local_estimate', outputSource = 'estimated' }) {
    const native = { ...nativeUsage };
    const known = name => valid(native[name]);
    const inputFields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
    const missing = inputFields.filter(name => !known(name));
    // A provider total and two provider components uniquely determine the third.
    // This is exact provider arithmetic, independent of local cache estimates.
    if (totalSource === 'provider_total' && valid(inputTokens) && missing.length === 1) {
        const reported = inputFields.reduce((sum, name) => sum + (known(name) ? native[name] : 0), 0);
        if (valid(reported) && reported <= inputTokens) native[missing[0]] = inputTokens - reported;
    }
    const estimated = splitKiroCacheUsage(inputTokens, plan);
    const canEstimate = mode === 'estimate' && plan && ![
        'missing_payload', 'invalid_cache_control', 'too_many_breakpoints', 'unmapped_breakpoint', 'invalid_ttl_order'
    ].includes(plan.reason);
    let input = known('input_tokens') ? native.input_tokens : integer(inputTokens);
    let read = known('cache_read_input_tokens') ? native.cache_read_input_tokens : 0;
    let creation = known('cache_creation_input_tokens') ? native.cache_creation_input_tokens : 0;
    let conflict = false;
    if (canEstimate) {
        const total = Math.max(integer(inputTokens), read + creation + (known('input_tokens') ? input : 0));
        conflict = total > integer(inputTokens);
        let remaining = total - read - creation - (known('input_tokens') ? input : 0);
        if (!known('cache_read_input_tokens')) {
            read = Math.min(remaining, estimated.read);
            remaining -= read;
        }
        if (!known('cache_creation_input_tokens')) {
            creation = Math.min(remaining, estimated.creation);
            remaining -= creation;
        }
        if (!known('input_tokens')) input = remaining;
        // A provider-reported uncached count is authoritative. Any unused
        // estimated total remains a diagnostic, not phantom cache creation.
    }
    const usage = {
        input_tokens: input,
        output_tokens: known('output_tokens') ? native.output_tokens : integer(outputTokens),
        cache_creation_input_tokens: creation, cache_read_input_tokens: read,
        ...metering
    };
    if (canEstimate && !known('cache_creation_input_tokens')) {
        const oneHour = estimated.creation > 0 ? Math.min(creation, Math.round(creation * estimated.oneHour / estimated.creation)) : 0;
        usage.cache_creation = { ephemeral_5m_input_tokens: creation - oneHour, ephemeral_1h_input_tokens: oneHour };
    }
    const sources = {
        input_tokens: known('input_tokens') || !canEstimate && totalSource === 'provider_total' ? 'provider' : 'estimated',
        output_tokens: known('output_tokens') ? 'provider' : outputSource,
        cache_read_input_tokens: known('cache_read_input_tokens') ? 'provider' : canEstimate ? 'estimated' : 'unavailable',
        cache_creation_input_tokens: known('cache_creation_input_tokens') ? 'provider' : canEstimate ? 'estimated' : 'unavailable'
    };
    const details = { version: 1, stage: 'final', mode, policy: plan?.policy || null,
        reason: conflict ? 'provider_exceeds_estimated_total' : plan?.reason || null,
        totalInputTokens: input + read + creation,
        totalSource: ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].every(known)
            ? 'provider' : ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
                .some(known) ? 'mixed' : totalSource,
        sources,
        ...(mode === 'observe' ? { observed: estimated } : {}) };
    return { usage: attachKiroUsageDetails(usage, details), details };
}
