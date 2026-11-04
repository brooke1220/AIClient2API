/** Normalize Kiro's final token snapshot without treating missing values as zero. */
export function readKiroTokenUsage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result = {};
    for (const [source, target] of [
        ['uncachedInputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'],
        ['cacheReadInputTokens', 'cache_read_input_tokens'], ['cacheWriteInputTokens', 'cache_creation_input_tokens']
    ]) {
        if (Number.isSafeInteger(value[source]) && value[source] >= 0) result[target] = value[source];
    }
    return Object.keys(result).length ? result : null;
}

export function readKiroMetering(value) {
    if (!value || !Number.isFinite(value.usage) || value.usage < 0 ||
        typeof value.unit !== 'string' || !value.unit || value.unit.length > 64) return null;
    return { credit_usage: value.usage, credit_unit: value.unit,
        ...(typeof value.unitPlural === 'string' && value.unitPlural.length <= 64 ? { credit_unit_plural: value.unitPlural } : {}) };
}

export function kiroRefusalText(metadata) {
    const refusal = metadata?.stopDetails?.refusal;
    const details = [refusal?.category, refusal?.explanation]
        .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0, 2048));
    return details.join(': ') || 'The upstream model declined to answer this request.';
}
