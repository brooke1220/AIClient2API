const GPT_EFFORT_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

// Kiro only accepts additionalModelRequestFields for models whose schema exposes
// effort controls. Older Claude 4.5/Haiku models reject the whole field with 400.
const CLAUDE_EFFORT_LEVELS = new Map([
    ['claude-opus-5.5', new Set(['low', 'medium', 'high', 'xhigh', 'max'])],
    ['claude-sonnet-5.5', new Set(['low', 'medium', 'high', 'xhigh', 'max'])],
    ['claude-opus-5', new Set(['low', 'medium', 'high', 'xhigh', 'max'])],
    ['claude-opus-4.8', new Set(['low', 'medium', 'high', 'xhigh', 'max'])],
    ['claude-opus-4.7', new Set(['low', 'medium', 'high', 'xhigh', 'max'])],
    ['claude-opus-4.6', new Set(['low', 'medium', 'high', 'max'])],
    ['claude-sonnet-5', new Set(['low', 'medium', 'high', 'xhigh', 'max'])],
    ['claude-sonnet-4.6', new Set(['low', 'medium', 'high', 'max'])]
]);

const GPT_EFFORT_MODELS = new Set([
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna'
]);

function normalizeModel(model) {
    return String(model || '').toLowerCase().replace(/^[^:]+:/, '').replace('gpt-5_6', 'gpt-5.6');
}

/** Existing explicit fields win; active thinking.effort is the compatibility fallback. */
export function resolveKiroRequestedEffort(thinking, outputConfig = null, reasoningEffort = null) {
    const type = String(thinking?.type || '').toLowerCase().trim();
    const thinkingEffort = type === 'enabled' || type === 'adaptive' ? thinking?.effort : null;
    for (const effort of [reasoningEffort, outputConfig?.effort, thinkingEffort]) {
        if (typeof effort === 'string' && effort.trim()) return effort.toLowerCase().trim();
    }
    return '';
}

/**
 * Build Kiro's model-specific effort extension. Unsupported models must omit
 * additionalModelRequestFields entirely; Kiro does not ignore unknown fields.
 */
export function buildKiroAdditionalModelRequestFields(model, thinking, outputConfig = null, reasoningEffort = null) {
    const normalizedModel = normalizeModel(model);
    if (GPT_EFFORT_MODELS.has(normalizedModel)) {
        // Keep the pre-existing GPT behavior; the new thinking.effort fallback
        // belongs to Claude compatibility, not another model family's namespace.
        const value = reasoningEffort || outputConfig?.effort;
        const explicitEffort = typeof value === 'string' ? value.toLowerCase().trim() : '';
        let effort = '';
        if (thinking?.type === 'disabled') {
            effort = 'none';
        } else if (explicitEffort) {
            effort = GPT_EFFORT_LEVELS.has(explicitEffort) ? explicitEffort : 'high';
        }

        return effort ? { reasoning: { effort } } : undefined;
    }

    const supportedLevels = CLAUDE_EFFORT_LEVELS.get(normalizedModel);
    if (!supportedLevels) {
        return undefined;
    }

    const requestedEffort = resolveKiroRequestedEffort(thinking, outputConfig, reasoningEffort);
    const thinkingType = String(thinking?.type || '').toLowerCase().trim();
    let effort = '';
    if (requestedEffort) {
        effort = supportedLevels.has(requestedEffort) ? requestedEffort : 'medium';
    } else if (thinkingType === 'enabled' || thinkingType === 'adaptive') {
        effort = 'medium';
    }

    return effort ? { output_config: { effort } } : undefined;
}
