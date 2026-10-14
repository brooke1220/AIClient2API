import { createHash } from 'node:crypto';

// Conservative application-side field budget, not a claim about every Kiro endpoint.
export const KIRO_TOOL_DESCRIPTION_MAX_BYTES = 9216;
const DEFAULT_TOOL_ARG_SOFT_LIMIT_BYTES = 16 * 1024;

function policyError(message) {
    const error = new Error(message);
    error.status = 400;
    error.response = { status: 400 };
    error.skipErrorCount = true;
    return error;
}

/** Append only gateway-owned additions; never rewrite or trim client instructions. */
export function appendKiroPromptAdditions(prompt, additions) {
    let result = prompt || '';
    for (const addition of additions) {
        if (!addition || result.includes(addition)) continue;
        result = result ? `${result}\n\n${addition}` : addition;
    }
    return result;
}

export function getKiroIdentityPrompt(config = {}) {
    return typeof config.KIRO_IDENTITY_PROMPT === 'string' ? config.KIRO_IDENTITY_PROMPT.trim() : '';
}

/** Effort fields and prompt-based thinking are separate compatibility mechanisms. */
export function shouldUseKiroThinkingPrompt(model, additionalFields, config = {}) {
    const mode = config.KIRO_THINKING_PROMPT_MODE ?? 'auto';
    if (!['auto', 'legacy', 'off'].includes(mode)) {
        throw policyError('KIRO_THINKING_PROMPT_MODE must be auto, legacy or off');
    }
    // Claude's legacy XML must never be injected into another model family.
    if (mode === 'off' || !/^claude[-.]/i.test(String(model).replace(/^[^:]+:/, ''))) return false;
    if (mode === 'legacy') return true;
    // Effort adjusts intensity; it is not an activation control. The current
    // model mapper emits effort-only fields, so auto retains the established XML
    // path. Only an explicit native thinking control can make it redundant.
    const nativeType = additionalFields?.thinking?.type;
    const hasNativeThinkingControl = typeof nativeType === 'string'
        && ['enabled', 'adaptive', 'disabled'].includes(nativeType.trim().toLowerCase());
    return !hasNativeThinkingControl;
}

function isFileMutationTool(tool) {
    const name = String(tool.name || '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    if (!/(?:^|[_.:-])(?:write|create|edit|patch|replace|insert|append|str_replace)(?:$|[_.:-])/.test(name)) return false;
    // Require file context as well as mutation/content signals. A create_user or
    // write_database operation must never get advice to split a file write.
    const contentFields = new Set(['content', 'contents', 'text', 'patch', 'diff', 'new_string', 'new_str', 'new_text', 'replacement', 'edits', 'input']);
    const pathFields = new Set(['path', 'file', 'file_path', 'filePath', 'filename', 'absolute_path', 'target_file']);
    const hasField = (schema, fields, depth = 0) => {
        if (!schema || typeof schema !== 'object' || depth > 5) return false;
        const properties = schema.properties || {};
        if (Object.keys(properties).some(key => fields.has(key))) return true;
        if (Object.values(properties).some(item => hasField(item, fields, depth + 1)) || hasField(schema.items, fields, depth + 1)) return true;
        return ['anyOf', 'oneOf', 'allOf'].some(key => Array.isArray(schema[key]) && schema[key].some(item => hasField(item, fields, depth + 1)));
    };
    const baseName = name.split(/__|[.:]/).at(-1);
    const commonFileTools = new Set(['write', 'edit', 'replace', 'str_replace', 'str_replace_editor', 'multi_edit', 'edit_text', 'replace_text', 'append_text']);
    const fileContext = /(?:^|[_.:-])(?:files?|patch)(?:$|[_.:-])/.test(name)
        || (commonFileTools.has(baseName) && hasField(tool.input_schema, pathFields));
    return fileContext && hasField(tool.input_schema, contentFields);
}

export function getKiroToolSizeHint(tool, config = {}) {
    if (config.KIRO_TOOL_SIZE_HINTS === false || !isFileMutationTool(tool)) return '';
    const configured = config.KIRO_TOOL_ARG_SOFT_LIMIT_BYTES;
    const target = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_TOOL_ARG_SOFT_LIMIT_BYTES;
    return `[Gateway large-argument advisory] Only for large file writes/edits: when serialized arguments would exceed about ${target} UTF-8 bytes, prefer smaller valid edits or staged writes using the available tools. Keep small edits in one call. Preserve atomicity and the tool's documented semantics; do not split an operation when that would change its meaning. This is an advisory target, not an upstream limit.`;
}

/** Preserve a long description verbatim in a deterministic, referenced document. */
export function prepareKiroToolDescription(tool, wireName, config = {}) {
    const mode = config.KIRO_TOOL_DESCRIPTION_MODE ?? 'reference';
    if (!['reference', 'error'].includes(mode)) {
        throw policyError('KIRO_TOOL_DESCRIPTION_MODE must be reference or error');
    }
    const original = tool.description;
    const description = appendKiroPromptAdditions(original, [getKiroToolSizeHint(tool, config)]);
    if (Buffer.byteLength(description) <= KIRO_TOOL_DESCRIPTION_MAX_BYTES) return { description, documentation: '' };
    if (mode === 'error') throw policyError(`Kiro tool '${wireName}' description exceeds the ${KIRO_TOOL_DESCRIPTION_MAX_BYTES}-byte field budget; use KIRO_TOOL_DESCRIPTION_MODE=reference to preserve it`);
    const digest = createHash('sha256').update(wireName).update('\0').update(description).digest('hex').slice(0, 16);
    const reference = `kiro-tool-doc-${digest}`;
    return {
        description: `Read the complete description for tool '${wireName}' in the '${reference}' tool documentation section.`,
        documentation: `## Tool documentation: ${reference}\nTool name: ${wireName}\n\n${description}`
    };
}
