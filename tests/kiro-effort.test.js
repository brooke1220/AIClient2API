import { buildKiroAdditionalModelRequestFields, isKiroAlwaysOnThinkingModel } from '../src/providers/claude/kiro-effort.js';

const model = 'claude-sonnet-4.6';
const fields = (thinking, outputConfig = null, reasoningEffort = null, name = model) =>
    buildKiroAdditionalModelRequestFields(name, thinking, outputConfig, reasoningEffort);
const adaptive = effort => ({ output_config: { effort }, thinking: { type: 'adaptive' } });

describe('Kiro Claude effort mapping preserves every supported request source', () => {
    test.each(['low', 'medium', 'high'])('adaptive thinking.effort=%s reaches the wire', effort => {
        expect(fields({ type: 'adaptive', effort })).toEqual(adaptive(effort));
    });
    test.each(['low', 'high'])('enabled thinking.effort=%s reaches the wire as native adaptive', effort => {
        expect(fields({ type: 'enabled', effort })).toEqual(adaptive(effort));
    });
    test('reasoning_effort takes priority over output_config and thinking.effort', () => {
        expect(fields({ type: 'adaptive', effort: 'high' }, { effort: 'max' }, 'low')).toEqual(adaptive('low'));
    });
    test('output_config takes priority over thinking.effort', () => {
        expect(fields({ type: 'adaptive', effort: 'high' }, { effort: 'low' })).toEqual(adaptive('low'));
    });
    test('empty higher-priority strings do not hide a lower-priority explicit setting', () => {
        expect(fields({ type: 'adaptive', effort: 'high' }, { effort: 'low' }, '  ')).toEqual(adaptive('low'));
        expect(fields({ type: 'adaptive', effort: 'low' }, { effort: '  ' }, '')).toEqual(adaptive('low'));
    });
    test('thinking type and effort are normalized consistently with XML compatibility', () => {
        expect(fields({ type: ' ADAPTIVE ', effort: ' HIGH ' })).toEqual(adaptive('high'));
    });
    test('missing and unknown levels keep the medium default', () => {
        expect(fields({ type: 'adaptive' })).toEqual(adaptive('medium'));
        expect(fields({ type: 'adaptive', effort: 'not-supported' })).toEqual(adaptive('medium'));
    });
    test('a known level the model lacks steps down to the nearest supported level', () => {
        expect(fields({ type: 'adaptive', effort: 'xhigh' })).toEqual(adaptive('high'));
        expect(fields({ type: 'adaptive', effort: 'xhigh' }, null, null, 'claude-opus-4.6')).toEqual(adaptive('high'));
    });
    test('supported xhigh is not downgraded on models whose existing map allows it', () => {
        expect(fields({ type: 'adaptive', effort: 'xhigh' }, null, null, 'claude-opus-4.7')).toEqual(adaptive('xhigh'));
    });
    test('an invalid explicit higher-priority level does not silently yield to a lower source', () => {
        expect(fields({ type: 'adaptive', effort: 'low' }, { effort: 'high' }, 'unsupported')).toEqual(adaptive('medium'));
    });
    test('disabled thinking reaches the wire without a nested effort turning it on', () => {
        expect(fields({ type: 'disabled', effort: 'high' })).toEqual({ thinking: { type: 'disabled' } });
    });
    test('no thinking request cannot turn on an implicit effort field', () => {
        expect(fields({ type: undefined, effort: 'high' })).toBeUndefined();
    });
    test('an independently explicit output setting is still supported with thinking disabled', () => {
        expect(fields({ type: 'disabled', effort: 'high' }, { effort: 'low' })).toEqual({ output_config: { effort: 'low' }, thinking: { type: 'disabled' } });
    });
    test('disabled thinking does not cap an explicit xhigh or max effort', () => {
        expect(fields({ type: 'disabled' }, { effort: 'max' })).toEqual({ output_config: { effort: 'max' }, thinking: { type: 'disabled' } });
        expect(fields({ type: 'disabled' }, { effort: 'xhigh' }, null, 'claude-opus-5')).toEqual({ output_config: { effort: 'xhigh' }, thinking: { type: 'disabled' } });
    });
    test.each(['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.6', 'claude-sonnet-4.6'])('toggle model %s sends adaptive and disabled natively', name => {
        expect(fields({ type: 'adaptive', effort: 'high' }, null, null, name)).toEqual(adaptive('high'));
        expect(fields({ type: 'disabled' }, null, null, name)).toEqual({ thinking: { type: 'disabled' } });
        expect(isKiroAlwaysOnThinkingModel(name)).toBe(false);
    });
    test.each(['claude-opus-5.5', 'claude-sonnet-5.5'])('always-on model %s sends effort only, never a thinking toggle', name => {
        expect(fields({ type: 'adaptive', effort: 'xhigh' }, null, null, name)).toEqual({ output_config: { effort: 'xhigh' } });
        expect(fields({ type: 'disabled' }, { effort: 'high' }, null, name)).toEqual({ output_config: { effort: 'high' } });
        expect(fields({ type: 'disabled' }, null, null, name)).toBeUndefined();
    });
    test('always-on detection covers only effort models without a thinking toggle', () => {
        expect(isKiroAlwaysOnThinkingModel('claude-opus-5.5')).toBe(true);
        expect(isKiroAlwaysOnThinkingModel('kiro:claude-sonnet-5.5')).toBe(true);
        expect(isKiroAlwaysOnThinkingModel('claude-sonnet-4.6')).toBe(false);
        expect(isKiroAlwaysOnThinkingModel('claude-sonnet-4.5')).toBe(false);
        expect(isKiroAlwaysOnThinkingModel('gpt-5.6-sol')).toBe(false);
    });
    test.each(['claude-sonnet-4.5', 'claude-haiku-4.5', 'unverified-model'])('unsupported model %s still omits the entire extension', name => {
        expect(fields({ type: 'adaptive', effort: 'high' }, null, null, name)).toBeUndefined();
        expect(fields({ type: 'disabled' }, null, null, name)).toBeUndefined();
        expect(fields(null, { effort: 'high' }, '  ', name)).toBeUndefined();
    });
    test('the incoming objects are not mutated', () => {
        const thinking = Object.freeze({ type: 'adaptive', effort: 'high' });
        const output = Object.freeze({ effort: 'low' });
        expect(fields(thinking, output)).toEqual(adaptive('low'));
        expect(thinking.effort).toBe('high');
    });
    test('GPT retains its own namespace, precedence and explicit disabled control', () => {
        const name = 'gpt-5.6-sol';
        expect(fields({ type: 'adaptive', effort: 'high' }, null, null, name)).toBeUndefined();
        expect(fields(null, { effort: 'medium' }, 'low', name)).toEqual({ reasoning: { effort: 'low' } });
        expect(fields({ type: 'disabled' }, { effort: 'high' }, 'max', name)).toEqual({ reasoning: { effort: 'none' } });
    });
});
