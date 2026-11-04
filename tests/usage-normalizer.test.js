import { emptyNormalizedUsage, extractNormalizedUsage, mergeNormalizedUsage, normalizeUsageCandidate } from '../src/utils/usage-normalizer.js';
import { attachKiroUsageDetails } from '../src/providers/claude/kiro-cache-usage.js';

function finalUsage(values = {}) {
    return attachKiroUsageDetails({ input_tokens: 2000, cache_read_input_tokens: 8000,
        cache_creation_input_tokens: 2000, output_tokens: 6, ...values }, {
        stage: 'final', sources: { cache_read_input_tokens: 'estimated', cache_creation_input_tokens: 'estimated' }
    });
}

describe('shared usage normalization', () => {
    test('Anthropic input excludes caches while OpenAI input includes them', () => {
        const native = { type: 'message', usage: finalUsage() };
        const converted = { usage: { prompt_tokens: 12000, completion_tokens: 6, total_tokens: 12006,
            prompt_tokens_details: { cached_tokens: 8000 } } };
        expect(extractNormalizedUsage(native, converted)).toMatchObject({ promptTokens: 12000, completionTokens: 6,
            totalTokens: 12006, cachedTokens: 8000, cacheCreationTokens: 2000, cacheSource: 'estimated' });
        expect(extractNormalizedUsage(converted, native)).toEqual(extractNormalizedUsage(native, converted));
        expect(extractNormalizedUsage({ response: { usage: { input_tokens: 12000, output_tokens: 6,
            input_tokens_details: { cached_tokens: 8000 }, total_tokens: 12006 } } })).toMatchObject({ promptTokens: 12000, totalTokens: 12006 });
    });
    test('final snapshots replace provisional totals, downward corrections and explicit zeros', () => {
        const initial = extractNormalizedUsage({ type: 'message_start', message: { usage: { input_tokens: 30000,
            output_tokens: 0, cache_read_input_tokens: 15000, cache_creation_input_tokens: 10000 } } });
        const final = extractNormalizedUsage({ type: 'message_delta', usage: finalUsage() });
        const result = mergeNormalizedUsage(initial, final);
        expect(result).toMatchObject({ promptTokens: 12000, totalTokens: 12006, cachedTokens: 8000, cacheCreationTokens: 2000 });
        expect(mergeNormalizedUsage(result, initial)).toEqual(result);
        const zero = extractNormalizedUsage({ type: 'message_delta', usage: finalUsage({ input_tokens: 0,
            cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }) });
        expect(mergeNormalizedUsage(result, zero)).toMatchObject(emptyNormalizedUsage());
    });
    test('partial Anthropic deltas preserve input and recompute the combined total', () => {
        const initial = { message: { usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 } } };
        const final = { type: 'message_delta', usage: { output_tokens: 20 } };
        expect(extractNormalizedUsage([initial, final])).toMatchObject({ promptTokens: 450, completionTokens: 20,
            totalTokens: 470, cachedTokens: 300, cacheCreationTokens: 50, cacheReadSource: 'provider' });
    });
    test('Claude-format chunks carrying OpenAI totals keep their net input', () => {
        expect(extractNormalizedUsage({ type: 'message_delta', usage: { input_tokens: 200, cache_creation_input_tokens: 0,
            cache_read_input_tokens: 800, output_tokens: 50, prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050,
            cached_tokens: 800 } })).toMatchObject({ promptTokens: 1000, totalTokens: 1050, cachedTokens: 800 });
    });
    test('OpenAI reasoning is a subset of output; Gemini thoughts are separate output', () => {
        expect(extractNormalizedUsage({ usage: { prompt_tokens: 10, completion_tokens: 20,
            completion_tokens_details: { reasoning_tokens: 8 } } })).toMatchObject({ completionTokens: 20, totalTokens: 30 });
        expect(extractNormalizedUsage({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 12,
            thoughtsTokenCount: 8, cachedContentTokenCount: 4, totalTokenCount: 30 } }))
            .toMatchObject({ promptTokens: 10, completionTokens: 20, totalTokens: 30, cachedTokens: 4 });
    });
    test('missing cache fields stay unavailable, native zeros and mixed sources are distinguishable', () => {
        expect(extractNormalizedUsage({ usage: { prompt_tokens: 5, completion_tokens: 1 } }).cacheSource).toBe('unavailable');
        expect(extractNormalizedUsage({ usage: { input_tokens: 5, cache_read_input_tokens: 0 } }).cacheSource).toBe('provider');
        const usage = attachKiroUsageDetails({ input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 2 },
            { stage: 'final', sources: { cache_read_input_tokens: 'provider', cache_creation_input_tokens: 'estimated' } });
        expect(extractNormalizedUsage({ usage }).cacheSource).toBe('mixed');
    });
    test('raw usage objects, chunk arrays, empty and invalid candidates are handled', () => {
        expect(extractNormalizedUsage({ output_tokens: 9 })).toMatchObject({ completionTokens: 9, totalTokens: 9 });
        expect(extractNormalizedUsage([{ prompt_tokens: 10 }, { completion_tokens: 20 }])).toMatchObject({ totalTokens: 30 });
        expect(normalizeUsageCandidate({ choices: [] })).toBeNull();
        expect(extractNormalizedUsage(null, [], { usage: { prompt_tokens: -4, completion_tokens: 'invalid' } })).toMatchObject(emptyNormalizedUsage());
    });
});
