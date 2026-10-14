import { buildKiroAdditionalModelRequestFields } from '../src/providers/claude/kiro-effort.js';

const model = 'claude-sonnet-4.6';
const fields = (thinking, outputConfig = null, reasoningEffort = null, name = model) =>
    buildKiroAdditionalModelRequestFields(name, thinking, outputConfig, reasoningEffort);

describe('Kiro Claude effort mapping preserves every supported request source', () => {
    test.each(['low', 'medium', 'high'])('adaptive thinking.effort=%s reaches the wire', effort => {
        expect(fields({ type: 'adaptive', effort })).toEqual({ output_config: { effort } });
    });
    test.each(['low', 'high'])('enabled thinking.effort=%s reaches the wire', effort => {
        expect(fields({ type: 'enabled', effort })).toEqual({ output_config: { effort } });
    });
    test('reasoning_effort takes priority over output_config and thinking.effort', () => {
        expect(fields({ type: 'adaptive', effort: 'high' }, { effort: 'max' }, 'low')).toEqual({ output_config: { effort: 'low' } });
    });
    test('output_config takes priority over thinking.effort', () => {
        expect(fields({ type: 'adaptive', effort: 'high' }, { effort: 'low' })).toEqual({ output_config: { effort: 'low' } });
    });
    test('empty higher-priority strings do not hide a lower-priority explicit setting', () => {
        expect(fields({ type: 'adaptive', effort: 'high' }, { effort: 'low' }, '  ')).toEqual({ output_config: { effort: 'low' } });
        expect(fields({ type: 'adaptive', effort: 'low' }, { effort: '  ' }, '')).toEqual({ output_config: { effort: 'low' } });
    });
    test('thinking type and effort are normalized consistently with XML compatibility', () => {
        expect(fields({ type: ' ADAPTIVE ', effort: ' HIGH ' })).toEqual({ output_config: { effort: 'high' } });
    });
    test('missing and unsupported levels keep the existing model-specific fallback', () => {
        expect(fields({ type: 'adaptive' })).toEqual({ output_config: { effort: 'medium' } });
        expect(fields({ type: 'adaptive', effort: 'not-supported' })).toEqual({ output_config: { effort: 'medium' } });
        expect(fields({ type: 'adaptive', effort: 'xhigh' })).toEqual({ output_config: { effort: 'medium' } });
    });
    test('supported xhigh is not downgraded on models whose existing map allows it', () => {
        expect(fields({ type: 'adaptive', effort: 'xhigh' }, null, null, 'claude-opus-4.7')).toEqual({ output_config: { effort: 'xhigh' } });
    });
    test('an invalid explicit higher-priority level does not silently yield to a lower source', () => {
        expect(fields({ type: 'adaptive', effort: 'low' }, { effort: 'high' }, 'unsupported')).toEqual({ output_config: { effort: 'medium' } });
    });
    test.each(['disabled', undefined])('inactive thinking (%p) cannot turn on an implicit effort field', type => {
        expect(fields({ type, effort: 'high' })).toBeUndefined();
    });
    test('an independently explicit output setting is still supported with thinking disabled', () => {
        expect(fields({ type: 'disabled', effort: 'high' }, { effort: 'low' })).toEqual({ output_config: { effort: 'low' } });
    });
    test.each(['claude-sonnet-4.5', 'claude-haiku-4.5', 'unverified-model'])('unsupported model %s still omits the entire extension', name => {
        expect(fields({ type: 'adaptive', effort: 'high' }, null, null, name)).toBeUndefined();
        expect(fields(null, { effort: 'high' }, '  ', name)).toBeUndefined();
    });
    test('the incoming objects are not mutated', () => {
        const thinking = Object.freeze({ type: 'adaptive', effort: 'high' });
        const output = Object.freeze({ effort: 'low' });
        expect(fields(thinking, output)).toEqual({ output_config: { effort: 'low' } });
        expect(thinking.effort).toBe('high');
    });
    test('GPT retains its own namespace, precedence and explicit disabled control', () => {
        const name = 'gpt-5.6-sol';
        expect(fields({ type: 'adaptive', effort: 'high' }, null, null, name)).toBeUndefined();
        expect(fields(null, { effort: 'medium' }, 'low', name)).toEqual({ reasoning: { effort: 'low' } });
        expect(fields({ type: 'disabled' }, { effort: 'high' }, 'max', name)).toEqual({ reasoning: { effort: 'none' } });
    });
});
