const GPT_EFFORT_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

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

// Kiro's schema allows thinking.type adaptive|disabled only for these models.
// The other effort models accept only always-on modes and think natively
// without the field, so they get none, matching Kiro IDE.
const CLAUDE_THINKING_TOGGLE_MODELS = new Set([
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4.8',
    'claude-opus-4.7',
    'claude-opus-4.6',
    'claude-sonnet-4.6'
]);

const GPT_EFFORT_MODELS = new Set([
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna'
]);

function normalizeModel(model) {
    return String(model || '').toLowerCase().replace(/^[^:]+:/, '').replace('gpt-5_6', 'gpt-5.6');
}

/** Claude models whose Kiro thinking is always on, so neither a toggle nor XML is needed. */
export function isKiroAlwaysOnThinkingModel(model) {
    const normalizedModel = normalizeModel(model);
    return CLAUDE_EFFORT_LEVELS.has(normalizedModel) && !CLAUDE_THINKING_TOGGLE_MODELS.has(normalizedModel);
}

/** Step down to the nearest supported level; unknown values keep the medium default. */
function fallbackEffort(requestedEffort, supportedLevels) {
    for (let index = EFFORT_ORDER.indexOf(requestedEffort) - 1; index >= 0; index--) {
        if (supportedLevels.has(EFFORT_ORDER[index])) return EFFORT_ORDER[index];
    }
    return 'medium';
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
 * Build Kiro's model-specific effort and native thinking extension. Unsupported
 * models must omit additionalModelRequestFields entirely; Kiro does not ignore
 * unknown fields.
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
    const thinkingActive = thinkingType === 'enabled' || thinkingType === 'adaptive';
    let effort = '';
    if (requestedEffort) {
        effort = supportedLevels.has(requestedEffort) ? requestedEffort : fallbackEffort(requestedEffort, supportedLevels);
    } else if (thinkingActive) {
        effort = 'medium';
    }

    // Kiro accepts disabled with xhigh/max, so unlike Kiro IDE the effort is not capped.
    let nativeThinking = '';
    if (CLAUDE_THINKING_TOGGLE_MODELS.has(normalizedModel)) {
        if (thinkingActive) nativeThinking = 'adaptive';
        else if (thinkingType === 'disabled') nativeThinking = 'disabled';
    }

    const fields = {};
    if (effort) fields.output_config = { effort };
    if (nativeThinking) fields.thinking = { type: nativeThinking };
    return Object.keys(fields).length > 0 ? fields : undefined;
}
