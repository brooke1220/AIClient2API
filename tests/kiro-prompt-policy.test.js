import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import {
    appendKiroPromptAdditions, getKiroIdentityPrompt, getKiroToolSizeHint,
    KIRO_TOOL_DESCRIPTION_MAX_BYTES, prepareKiroToolDescription, shouldUseKiroThinkingPrompt
} from '../src/providers/claude/kiro-prompt-policy.js';
import { model, service } from './helpers/kiro-safety-fixtures.js';

const tool = (name = 'read_file', description = 'Read a file') => ({
    name, description, input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }
});
const body = () => ({ messages: [{ role: 'user', content: 'hello' }] });
function backend(config = {}) {
    const value = service(undefined, config);
    value.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
    return value;
}
const current = payload => payload.conversationState.currentMessage.userInputMessage;
const specifications = payload => current(payload).userInputMessageContext.tools.filter(entry => entry.toolSpecification).map(entry => entry.toolSpecification);
const serializedText = payload => [
    ...(payload.conversationState.history || []).map(entry => entry.userInputMessage?.content || entry.assistantResponseMessage?.content || ''),
    current(payload).content
].join('\n');
function freezeDeep(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
    return value;
}

beforeEach(() => jest.clearAllMocks());

describe('minimal, opt-in Kiro prompt policy', () => {
    test('empty additions preserve the client text exactly; identical gateway additions occur once', () => {
        const original = '  Client instructions.\n';
        expect(appendKiroPromptAdditions(original, ['', null])).toBe(original);
        expect(appendKiroPromptAdditions(original, ['extra', 'extra'])).toBe(`${original}\n\nextra`);
    });
    test.each([{}, { KIRO_IDENTITY_PROMPT: false }, { KIRO_IDENTITY_PROMPT: '   ' }])('no implicit identity for %p', config => {
        expect(getKiroIdentityPrompt(config)).toBe('');
    });
    test('identity instructions are explicitly provided, not a hardcoded model-provenance claim', async () => {
        const value = backend({ KIRO_IDENTITY_PROMPT: 'Call this assistant Project Helper.' });
        const result = await value.buildCodewhispererRequest(body().messages, model, null, 'Keep the client rules.');
        expect(current(result).content).toBe('Keep the client rules.\n\nCall this assistant Project Helper.\n\nhello');
        expect(current(result).content).not.toContain('{{identity}}');
    });
    test('default requests add neither an identity nor a blanket file-writing rule', async () => {
        const result = await backend().buildCodewhispererRequest(body().messages, model);
        expect(current(result).content).toBe('hello');
        expect(result.conversationState.history).toBeUndefined();
        expect(serializedText(result)).not.toMatch(/CRITICAL_OVERRIDE|identity|强制拆小|Kiro|kiro/);
    });
    test.each([null, 'Client rules'])('single-turn orphan tool results are lossless with system=%p', async system => {
        const messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', is_error: true, content: 'failed output' }] }];
        const result = await backend().buildCodewhispererRequest(messages, model, null, system);
        expect(current(result).content).toContain('[Earlier tool result (error) omitted from history]\nfailed output');
        expect(current(result).userInputMessageContext.toolResults).toBeUndefined();
    });
    test('a single-turn client prompt is retained exactly once', async () => {
        const result = await backend().buildCodewhispererRequest(body().messages, model, null, 'Client-owned system');
        expect(current(result).content).toBe('Client-owned system\n\nhello');
        expect(result.conversationState.history).toBeUndefined();
    });
    test('multi-turn histories preserve instructions and do not add synthetic acknowledgements', async () => {
        const messages = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'next' }];
        const result = await backend().buildCodewhispererRequest(messages, model, null, 'Client-owned system');
        expect(result.conversationState.history).toHaveLength(2);
        expect(result.conversationState.history[0].userInputMessage.content).toBe('Client-owned system\n\nfirst');
        expect(current(result).content).toBe('next');
    });
    test.each([null, 'Client rules'])('assistant-first history keeps a minimal user-first shape with system=%p', async system => {
        const messages = [{ role: 'assistant', content: 'resumed answer' }, { role: 'user', content: 'continue' }];
        const result = await backend().buildCodewhispererRequest(messages, model, null, system);
        expect(result.conversationState.history[0].userInputMessage.content).toBe(system || '(empty placeholder)');
        expect(result.conversationState.history[1].assistantResponseMessage.content).toBe('resumed answer');
        expect(result.conversationState.history).toHaveLength(2);
        expect(current(result).content).toBe('continue');
    });
    test('assistant-first tool resumes preserve the paired result without an identity prefix', async () => {
        const messages = [
            { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'read_file', input: { path: 'file' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'actual output' }] }
        ];
        const result = await backend().buildCodewhispererRequest(messages, model, [tool()]);
        expect(result.conversationState.history[0].userInputMessage.content).toBe('(empty placeholder)');
        expect(result.conversationState.history[1].assistantResponseMessage.toolUses[0].toolUseId).toBe('t');
        expect(current(result).userInputMessageContext.toolResults).toEqual([{ toolUseId: 't', status: 'success', content: [{ text: 'actual output' }] }]);
    });
    test('an isolated assistant prefill fails as a client error, not a conversion crash', async () => {
        await expect(backend().buildCodewhispererRequest([{ role: 'assistant', content: [{ type: 'text', text: '{' }] }], model)).rejects.toMatchObject({ status: 400, skipErrorCount: true });
    });
    test.each(['', null, []])('empty assistant content %p does not crash request conversion', async content => {
        await expect(backend().buildCodewhispererRequest([{ role: 'user', content: 'first' }, { role: 'assistant', content }], model)).resolves.toHaveProperty('conversationState');
    });
});

describe('lossless, byte-bounded tool descriptions', () => {
    test('the exact ASCII field boundary is preserved in place', () => {
        const description = 'a'.repeat(KIRO_TOOL_DESCRIPTION_MAX_BYTES);
        expect(prepareKiroToolDescription(tool('read_file', description), 'read_file')).toEqual({ description, documentation: '' });
    });
    test.each(['a'.repeat(9217), '中'.repeat(3073), '🟢'.repeat(2305)])('oversized UTF-8 descriptions preserve the entire original', description => {
        const prepared = prepareKiroToolDescription(tool('read_file', description), 'read_file');
        expect(Buffer.byteLength(prepared.description)).toBeLessThanOrEqual(KIRO_TOOL_DESCRIPTION_MAX_BYTES);
        expect(prepared.documentation.endsWith(description)).toBe(true);
        expect(prepared.description).toMatch(/kiro-tool-doc-[a-f0-9]{16}/);
    });
    test('references are deterministic and change with the content or wire name', () => {
        const value = tool('read_file', 'x'.repeat(10000));
        const prepared = prepareKiroToolDescription(value, 'alias');
        expect(prepareKiroToolDescription(value, 'alias')).toEqual(prepared);
        expect(prepareKiroToolDescription(value, 'other').description).not.toBe(prepared.description);
        expect(prepareKiroToolDescription({ ...value, description: value.description + '!' }, 'alias').description).not.toBe(prepared.description);
    });
    test('strict mode returns a client error rather than truncating or dropping the tool', () => {
        expect(() => prepareKiroToolDescription(tool('read_file', 'x'.repeat(10000)), 'read_file', { KIRO_TOOL_DESCRIPTION_MODE: 'error' })).toThrow(/exceeds/);
        try { prepareKiroToolDescription(tool('read_file', 'x'.repeat(10000)), 'read_file', { KIRO_TOOL_DESCRIPTION_MODE: 'error' }); }
        catch (error) { expect(error).toMatchObject({ status: 400, skipErrorCount: true }); }
    });
    test('invalid description modes fail visibly', () => {
        expect(() => prepareKiroToolDescription(tool(), 'read_file', { KIRO_TOOL_DESCRIPTION_MODE: 'truncate' })).toThrow(/must be/);
    });
    test('long documentation is inserted once and does not mutate schemas, cache points, messages or tools', async () => {
        const description = 'x'.repeat(10000) + '\nCRITICAL TAIL: never overwrite an existing file.';
        const tools = freezeDeep([{ ...tool('read_file', description), cache_control: { type: 'ephemeral' } }]);
        const messages = freezeDeep([{ role: 'user', content: [{ type: 'text', text: 'first' }] }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'next' }]);
        const value = backend();
        const first = await value.buildCodewhispererRequest(messages, model, tools, 'Client rules');
        const second = await value.buildCodewhispererRequest(messages, model, tools, 'Client rules');
        expect(serializedText(first).split(description)).toHaveLength(2);
        expect(current(first).content).toBe('next');
        expect(specifications(first)).toEqual(specifications(second));
        expect(specifications(first)[0].inputSchema.json).toEqual(tools[0].input_schema);
        expect(current(first).userInputMessageContext.tools.at(-1)).toEqual({ cachePoint: { type: 'default' } });
        expect(tools[0].description).toBe(description);
        expect(messages[0].content).toEqual([{ type: 'text', text: 'first' }]);
    });
    test('documentation refers to the same shortened tool name sent on the wire', async () => {
        const tools = [tool('mcp__filesystem__' + 'long_namespace_'.repeat(8) + 'read_file', 'x'.repeat(10000))];
        const result = await backend().buildCodewhispererRequest(body().messages, model, tools);
        const wireName = specifications(result)[0].name;
        expect(wireName).toHaveLength(64);
        expect(specifications(result)[0].description).toContain(wireName);
        expect(current(result).content).toContain(`Tool name: ${wireName}`);
        expect(result._kiroToolNameMaps.fromKiroName(wireName)).toBe(tools[0].name);
    });
    test('full preserved documentation still obeys the final payload budget', async () => {
        await expect(backend({ KIRO_MAX_PAYLOAD_BYTES: 2000 }).buildCodewhispererRequest(body().messages, model, [tool('read_file', 'x'.repeat(10000))])).rejects.toMatchObject({ status: 413, skipErrorCount: true });
    });
    test('an already supplied identical documentation block is not appended again', async () => {
        const tools = [tool('read_file', 'x'.repeat(10000))];
        const { documentation } = prepareKiroToolDescription(tools[0], tools[0].name);
        const result = await backend().buildCodewhispererRequest(body().messages, model, tools, `Client rules\n\n${documentation}`);
        expect(current(result).content.split(documentation)).toHaveLength(2);
    });
});

describe('conditional large-file advice', () => {
    test.each(['write_file', 'writeToFile', 'mcp__filesystem__edit_file', 'apply_patch', 'str_replace'])('%s gets conditional, non-destructive advice', name => {
        const hint = getKiroToolSizeHint(tool(name));
        expect(hint).toContain('16384 UTF-8 bytes');
        expect(hint).toContain('Keep small edits in one call');
        expect(hint).toContain('Preserve atomicity');
        expect(hint).toContain('not an upstream limit');
    });
    test.each(['read_file', 'search', 'exec_command', 'create_user', 'write_database'])('%s gets no file-writing advice', name => {
        const value = tool(name);
        if (name === 'create_user' || name === 'write_database') value.input_schema = { type: 'object', properties: { content: { type: 'string' } } };
        expect(getKiroToolSizeHint(value)).toBe('');
    });
    test.each(['create_user', 'write_database'])('%s is not reclassified by an incidental path field', name => {
        expect(getKiroToolSizeHint(tool(name))).toBe('');
    });
    test('nested schemas for recognized file operations are supported conservatively', () => {
        const value = { ...tool('multi_edit'), input_schema: { type: 'object', properties: { edits: { type: 'array', items: { type: 'object', properties: { file_path: { type: 'string' }, new_text: { type: 'string' } } } } } } };
        expect(getKiroToolSizeHint(value)).toContain('large-argument advisory');
    });
    test('name alone without a content-bearing schema is not enough', () => {
        expect(getKiroToolSizeHint({ ...tool('write_file'), input_schema: { type: 'object', properties: { path: {} } } })).toBe('');
    });
    test('hints can be disabled or tuned independently', () => {
        expect(getKiroToolSizeHint(tool('write_file'), { KIRO_TOOL_SIZE_HINTS: false })).toBe('');
        expect(getKiroToolSizeHint(tool('write_file'), { KIRO_TOOL_ARG_SOFT_LIMIT_BYTES: 8000 })).toContain('8000 UTF-8 bytes');
        expect(getKiroToolSizeHint(tool('write_file'), { KIRO_TOOL_ARG_SOFT_LIMIT_BYTES: -1 })).toContain('16384 UTF-8 bytes');
    });
    test('the hint stays attached to its tool, not a global write-small instruction', async () => {
        const result = await backend().buildCodewhispererRequest(body().messages, model, [tool('write_file'), tool('read_file')]);
        expect(specifications(result)[0].description).toContain('large-argument advisory');
        expect(specifications(result)[1].description).not.toContain('large-argument advisory');
        expect(current(result).content).toBe('hello');
    });
});

describe('thinking transport selection', () => {
    test.each([
        ['claude-sonnet-4.5', undefined, {}, true],
        ['claude-sonnet-4.6', { output_config: { effort: 'medium' } }, {}, true],
        ['claude-sonnet-4.6', { output_config: { effort: 'medium' } }, { KIRO_THINKING_PROMPT_MODE: 'legacy' }, true],
        ['claude-sonnet-4.6', { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }, {}, false],
        ['claude-sonnet-4.6', { thinking: { type: 'enabled' } }, {}, false],
        ['claude-sonnet-4.6', { thinking: { type: 'disabled' } }, {}, false],
        ['claude-sonnet-4.6', { thinking: { type: 'unverified' } }, {}, true],
        ['claude-sonnet-4.5', undefined, { KIRO_THINKING_PROMPT_MODE: 'off' }, false],
        ['gpt-5.6-sol', undefined, { KIRO_THINKING_PROMPT_MODE: 'legacy' }, false]
    ])('%s fields=%p mode=%p selects legacy XML=%s', (name, fields, config, expected) => {
        expect(shouldUseKiroThinkingPrompt(name, fields, config)).toBe(expected);
    });
    test('invalid modes fail visibly', () => {
        expect(() => shouldUseKiroThinkingPrompt(model, undefined, { KIRO_THINKING_PROMPT_MODE: 'guess' })).toThrow(/must be/);
    });
    test('invalid policy configuration is rejected before sending an upstream request', async () => {
        const value = backend({ KIRO_THINKING_PROMPT_MODE: 'guess' });
        await expect(value.generateContent(model, body())).rejects.toMatchObject({ status: 400, skipErrorCount: true });
        expect(value._requestWithBuilderEndpointRouting).not.toHaveBeenCalled();
    });
    test('effort-only fields do not suppress the requested thinking activation', async () => {
        const result = await backend().buildCodewhispererRequest(body().messages, 'claude-sonnet-4.6', null, null, { type: 'enabled', budget_tokens: 10000 });
        expect(result.additionalModelRequestFields).toEqual({ output_config: { effort: 'medium' } });
        expect(current(result).content).toBe('<thinking_mode>enabled</thinking_mode><max_thinking_length>10000</max_thinking_length>\n\nhello');
    });
    test.each(['low', 'high'])('adaptive %s retains the established activation XML and the requested wire effort', async effort => {
        const result = await backend().buildCodewhispererRequest(body().messages, 'claude-sonnet-4.6', null, null, { type: 'adaptive', effort });
        expect(result.additionalModelRequestFields).toEqual({ output_config: { effort } });
        expect(current(result).content).toBe(`<thinking_mode>adaptive</thinking_mode><thinking_effort>${effort}</thinking_effort>\n\nhello`);
    });
    test.each([
        [{ effort: 'medium' }, 'low', 'low'],
        [{ effort: 'low' }, null, 'low'],
        [null, null, 'high']
    ])('the actual request uses one effective intensity for output=%p reasoning=%p', async (outputConfig, reasoningEffort, expected) => {
        const result = await backend().buildCodewhispererRequest(body().messages, 'claude-sonnet-4.6', null, null, { type: 'adaptive', effort: 'high' }, outputConfig, reasoningEffort);
        expect(result.additionalModelRequestFields).toEqual({ output_config: { effort: expected } });
        expect(current(result).content).toContain('<thinking_mode>adaptive</thinking_mode>');
        expect(current(result).content).toContain(`<thinking_effort>${expected}</thinking_effort>`);
    });
    test('a model-specific effort fallback is consistent with the compatibility XML', async () => {
        const result = await backend().buildCodewhispererRequest(body().messages, 'claude-sonnet-4.6', null, null, { type: 'adaptive', effort: 'unsupported' });
        expect(result.additionalModelRequestFields).toEqual({ output_config: { effort: 'medium' } });
        expect(current(result).content).toContain('<thinking_effort>medium</thinking_effort>');
    });
    test('effort without a thinking request does not inject an activation prompt', async () => {
        const result = await backend().buildCodewhispererRequest(body().messages, 'claude-sonnet-4.6', null, null, null, { effort: 'high' });
        expect(result.additionalModelRequestFields).toEqual({ output_config: { effort: 'high' } });
        expect(current(result).content).toBe('hello');
    });
    test('explicit effort priority is respected by the legacy-only XML path as well', async () => {
        const result = await backend().buildCodewhispererRequest(body().messages, model, null, null, { type: 'adaptive', effort: 'high' }, { effort: 'medium' }, 'low');
        expect(result.additionalModelRequestFields).toBeUndefined();
        expect(current(result).content).toContain('<thinking_effort>low</thinking_effort>');
    });
    test('off removes only gateway XML while preserving structured effort and client rules', async () => {
        const result = await backend({ KIRO_THINKING_PROMPT_MODE: 'off' }).buildCodewhispererRequest(body().messages, 'claude-sonnet-4.6', null, 'Client rules', { type: 'adaptive', effort: 'high' });
        expect(result.additionalModelRequestFields).toEqual({ output_config: { effort: 'high' } });
        expect(current(result).content).toBe('Client rules\n\nhello');
    });
    test('disabled thinking is not implicitly enabled by a nested effort', async () => {
        const result = await backend().buildCodewhispererRequest(body().messages, 'claude-sonnet-4.6', null, null, { type: 'disabled', effort: 'high' });
        expect(result.additionalModelRequestFields).toBeUndefined();
        expect(current(result).content).toBe('hello');
    });
    test('legacy fallback preserves its budget clamp without a new instruction to reveal reasoning', async () => {
        const result = await backend().buildCodewhispererRequest(body().messages, model, null, null, { type: 'enabled', budget_tokens: 999999 });
        expect(current(result).content).toContain('<max_thinking_length>24576</max_thinking_length>');
        expect(current(result).content).not.toMatch(/thinking_instruction|Think in English/);
        expect(result.additionalModelRequestFields).toBeUndefined();
    });
    test('off disables only gateway XML, never deletes client-provided instructions', async () => {
        const original = '<thinking_mode>client_defined</thinking_mode>\nClient rules';
        const result = await backend({ KIRO_THINKING_PROMPT_MODE: 'off' }).buildCodewhispererRequest(body().messages, model, null, original, { type: 'enabled' });
        expect(current(result).content).toBe(`${original}\n\nhello`);
    });
    test('an existing client thinking prefix is not duplicated', async () => {
        const result = await backend().buildCodewhispererRequest(body().messages, model, null, '<thinking_mode>enabled</thinking_mode>', { type: 'enabled' });
        expect(current(result).content.match(/<thinking_mode>/g)).toHaveLength(1);
    });
});
