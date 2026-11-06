// Client model names -> Kiro upstream model IDs. Kept free of imports so the
// pool manager can share it without loading the Kiro service.
export const KIRO_MODEL_MAPPING = Object.freeze({
    "gpt-5.6-sol":"gpt-5.6-sol",
    "gpt-5.6-terra":"gpt-5.6-terra",
    "gpt-5.6-luna":"gpt-5.6-luna",
    "claude-haiku-4-5":"claude-haiku-4.5",
    "claude-haiku-4-5-20251001":"claude-haiku-4.5",
    "claude-opus-5-5":"claude-opus-5.5",
    "claude-sonnet-5-5":"claude-sonnet-5.5",
    "claude-sonnet-5":"claude-sonnet-5",
    "claude-opus-5":"claude-opus-5",
    "claude-opus-4-8":"claude-opus-4.8",
    "claude-opus-4-7":"claude-opus-4.7",
    "claude-opus-4-6":"claude-opus-4.6",
    "claude-sonnet-4-6":"claude-sonnet-4.6",
    "claude-opus-4-5":"claude-opus-4.5",
    "claude-opus-4-5-20251101":"claude-opus-4.5",
    "claude-sonnet-4-5": "claude-sonnet-4.5",
    "claude-sonnet-4-5-20250929": "claude-sonnet-4.5"
});

/** Upstream ID when the name is a known alias; custom and unknown names pass through. */
export function kiroUpstreamModelId(model) {
    return Object.hasOwn(KIRO_MODEL_MAPPING, model) ? KIRO_MODEL_MAPPING[model] : model;
}
