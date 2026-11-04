import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import '../src/converters/register-converters.js';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { toClaudeInputUsage } from '../src/converters/utils.js';
import { extractNormalizedUsage } from '../src/utils/usage-normalizer.js';

// Every source reports 1000 total input tokens, 800 of which were cache reads.
const openaiUsage = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 800 } };
const responsesUsage = { input_tokens: 1000, output_tokens: 50, total_tokens: 1050, input_tokens_details: { cached_tokens: 800 } };
const geminiUsage = { promptTokenCount: 1000, candidatesTokenCount: 50, totalTokenCount: 1050, cachedContentTokenCount: 800 };
const text = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] };
const finalUsage = events => [events].flat().filter(Boolean).find(event => event.type === 'message_delta').usage;

const cases = {
    'OpenAI unary': () => new OpenAIConverter().toClaudeResponse({ choices: [{ message: { role: 'assistant', content: 'answer' },
        finish_reason: 'stop' }], usage: openaiUsage }, 'model').usage,
    'OpenAI stream': () => finalUsage(new OpenAIConverter().toClaudeStreamChunk({ choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: openaiUsage }, 'model')),
    'Responses unary': () => new OpenAIResponsesConverter().toClaudeResponse({ output: [text], usage: responsesUsage }, 'model').usage,
    'Responses stream': () => finalUsage(new OpenAIResponsesConverter().toClaudeStreamChunk({ type: 'response.completed',
        response: { output: [text], usage: responsesUsage } }, 'model', 'responses-stream')),
    'Codex unary': () => new CodexConverter().toClaudeResponse({ type: 'response.completed',
        response: { output: [text], usage: responsesUsage } }, 'model').usage,
    'Codex stream': () => finalUsage(new CodexConverter().toClaudeStreamChunk({ type: 'response.completed',
        response: { id: 'resp_1', output: [], usage: responsesUsage } }, 'model', 'codex-stream')),
    'Gemini unary': () => new GeminiConverter().toClaudeResponse({ candidates: [{ content: { parts: [{ text: 'answer' }] },
        finishReason: 'STOP' }], usageMetadata: geminiUsage }, 'model').usage,
    'Gemini stream': () => finalUsage(new GeminiConverter().toClaudeStreamChunk({ candidates: [{ finishReason: 'STOP' }],
        usageMetadata: geminiUsage }, 'model')),
    'Gemini tool stream': () => finalUsage(new GeminiConverter().toClaudeStreamChunk({ candidates: [{ finishReason: 'STOP',
        content: { parts: [{ functionCall: { name: 'lookup', args: {} } }] } }], usageMetadata: geminiUsage }, 'model'))
};

describe('Claude-format usage converted from cache-inclusive protocols', () => {
    test.each(Object.keys(cases))('%s reports net input and cache reads that sum to the source total', name => {
        const usage = cases[name]();
        expect(usage).toMatchObject({ input_tokens: 200, cache_read_input_tokens: 800, output_tokens: 50 });
        expect(extractNormalizedUsage({ type: 'message', usage })).toMatchObject({ promptTokens: 1000, totalTokens: 1050, cachedTokens: 800 });
    });

    test('statistics count a converted response once even when native and client usage are both observed', () => {
        const clientUsage = cases['OpenAI unary']();
        expect(extractNormalizedUsage({ usage: openaiUsage }, { type: 'message', usage: clientUsage }))
            .toMatchObject({ promptTokens: 1000, totalTokens: 1050, cachedTokens: 800 });
    });

    test('missing, invalid and inconsistent cache counts never produce negative input', () => {
        expect(toClaudeInputUsage(1000, undefined)).toEqual({ input_tokens: 1000, cache_read_input_tokens: 0 });
        expect(toClaudeInputUsage(undefined, 5)).toEqual({ input_tokens: 0, cache_read_input_tokens: 0 });
        expect(toClaudeInputUsage(100, 300)).toEqual({ input_tokens: 0, cache_read_input_tokens: 100 });
        expect(toClaudeInputUsage(100, -4)).toEqual({ input_tokens: 100, cache_read_input_tokens: 0 });
    });
});
