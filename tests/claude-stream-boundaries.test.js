import { jest } from '@jest/globals';
import { createOpenAI } from '@ai-sdk/openai';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';

const model = 'claude-sonnet-4-5';
const start = { type: 'message_start', message: { id: 'native-message', model, usage: { input_tokens: 12 } } };
const block = (index, content_block) => ({ type: 'content_block_start', index, content_block });
const text = (index, value) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } });
const args = (index, value) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: value } });
const stop = index => ({ type: 'content_block_stop', index });
const finish = (reason = 'end_turn') => ({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 8 } });
const end = { type: 'message_stop' };

function convert(chunks, protocol = 'openai', converter = new ClaudeConverter(), requestId = 'boundary-request') {
    return chunks.flatMap(chunk => {
        const converted = converter.convertStreamChunk(chunk, protocol, model, requestId);
        return converted ? (Array.isArray(converted) ? converted : [converted]) : [];
    });
}

const toolCalls = events => events.flatMap(event => event.choices[0].delta.tool_calls || []);

describe('Claude chat streaming boundary compatibility', () => {
    test('initial text and thinking survive content_block_start without later deltas', () => {
        const events = convert([
            start, block(0, { type: 'thinking', thinking: 'initial plan' }), stop(0),
            block(1, { type: 'text', text: 'initial answer' }), stop(1), finish(), end
        ]);
        expect(events.map(event => event.choices[0].delta.reasoning_content || '').join('')).toBe('initial plan');
        expect(events.map(event => event.choices[0].delta.content || '').join('')).toBe('initial answer');
    });

    test.each([{ path: 'a' }, '{"path":"a"}'])('complete initial tool input is retained: %p', input => {
        const calls = toolCalls(convert([
            start, block(5, { type: 'tool_use', id: 'tool-a', name: 'read', input }), stop(5), finish('tool_use'), end
        ]));
        expect(calls[0]).toMatchObject({ index: 0, id: 'tool-a', function: { name: 'read' } });
        expect(JSON.parse(calls.map(call => call.function.arguments).join(''))).toEqual({ path: 'a' });
    });

    test('an argument-free tool call finishes with a valid empty JSON object', () => {
        const calls = toolCalls(convert([
            start, block(5, { type: 'tool_use', id: 'tool-a', name: 'read', input: {} }), stop(5), finish('tool_use'), end
        ]));
        expect(calls.map(call => call.function.arguments).join('')).toBe('{}');
    });

    test('empty initial input is not prepended to streamed arguments', () => {
        const calls = toolCalls(convert([
            start, block(5, { type: 'tool_use', id: 'tool-a', name: 'read', input: {} }),
            args(5, '{"path":'), args(5, '"a"}'), stop(5), finish('tool_use'), end
        ]));
        expect(calls.map(call => call.function.arguments).join('')).toBe('{"path":"a"}');
    });

    test('an unannounced tool block cannot corrupt the first tool call', () => {
        const calls = toolCalls(convert([
            start, block(5, { type: 'tool_use', id: 'tool-a', name: 'read', input: {} }),
            args(99, 'unexpected arguments'), args(5, '{"path":"a"}'), stop(5), finish('tool_use'), end
        ]));
        expect(calls.map(call => call.function.arguments).join('')).toBe('{"path":"a"}');
    });

    test('repeated terminal metadata does not produce two finish chunks', () => {
        const converter = new ClaudeConverter();
        const events = convert([start, block(0, { type: 'text' }), text(0, 'answer'), stop(0), finish(), finish(), end, end], 'openai', converter);
        expect(events.filter(event => event.choices[0].finish_reason)).toHaveLength(1);
        expect(events.at(-1).usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
        expect(converter.openAIStreamStateCount()).toBe(0);
    });
});

describe('Claude chat stream metadata', () => {
    test('the first model identity remains stable when later callers omit the model', () => {
        const converter = new ClaudeConverter();
        const first = converter.toOpenAIStreamChunk(start, model, 'metadata');
        const second = converter.toOpenAIStreamChunk(text(0, 'answer'), undefined, 'metadata');
        expect(second).toMatchObject({ id: first.id, model: first.model, created: first.created });
        converter.toOpenAIStreamChunk(end, undefined, 'metadata');
        expect(converter.openAIStreamStateCount()).toBe(0);
    });

    test('a native stop sequence maps to the supported OpenAI stop reason', () => {
        const events = convert([start, text(0, 'answer'), finish('stop_sequence'), end]);
        expect(events.at(-1).choices[0].finish_reason).toBe('stop');
    });

    test('output-only usage updates retain the initial input and cached token counts', () => {
        const cachedStart = { ...start, message: { ...start.message, usage: { input_tokens: 12, cache_read_input_tokens: 7 } } };
        const events = convert([cachedStart, text(0, 'answer'), finish(), end]);
        expect(events.at(-1).usage).toMatchObject({
            prompt_tokens: 19, completion_tokens: 8, total_tokens: 27,
            cached_tokens: 7, prompt_tokens_details: { cached_tokens: 7 }
        });
    });
});

describe('Claude Responses streaming isolation and empty placeholders', () => {
    test('independent converters can use the same request key without sharing state', () => {
        const first = new ClaudeConverter(), second = new ClaudeConverter();
        convert([start, block(0, { type: 'text' }), text(0, 'first')], 'openaiResponses', first, 'same-key');
        convert([start, block(0, { type: 'text' }), text(0, 'second')], 'openaiResponses', second, 'same-key');
        const firstEnd = convert([finish(), end], 'openaiResponses', first, 'same-key');
        expect(firstEnd.at(-1).response.output[0].content[0].text).toBe('first');
        expect(first.openAIStreamStateCount()).toBe(0);
        expect(second.openAIStreamStateCount()).toBe(1);
        const secondEnd = convert([text(0, ' tail'), finish(), end], 'openaiResponses', second, 'same-key');
        expect(secondEnd.at(-1).response.output[0].content[0].text).toBe('second tail');
        expect(second.openAIStreamStateCount()).toBe(0);
    });

    test('an empty text placeholder before a tool does not announce a phantom assistant item', () => {
        const converter = new ClaudeConverter();
        const events = convert([
            start, block(0, { type: 'text', text: '' }), stop(0),
            block(5, { type: 'tool_use', id: 'tool-a', name: 'read', input: {} }), stop(5), finish('tool_use'), end
        ], 'openaiResponses', converter);
        expect(events.filter(event => event.type === 'response.output_item.added').map(event => event.item.type)).toEqual(['function_call']);
        expect(events.at(-1).response.output).toMatchObject([{ type: 'function_call', call_id: 'tool-a', arguments: '{}' }]);
        expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index));
        expect(convert([end], 'openaiResponses', converter)).toEqual([]);
        expect(converter.openAIStreamStateCount()).toBe(0);
    });
});


describe('Claude cached usage normalization', () => {
    const cachedUsage = {
        input_tokens: 2,
        cache_read_input_tokens: 1024,
        cache_creation_input_tokens: 16,
        cache_creation: { ephemeral_5m_input_tokens: 8, ephemeral_1h_input_tokens: 8 }
    };

    test.each(['openai', 'openaiResponses'])('%s streaming includes cache reads and writes without double-counting cumulative updates', protocol => {
        const cachedStart = { ...start, message: { ...start.message, usage: cachedUsage } };
        const cumulativeUsage = { type: 'message_delta', delta: {}, usage: { ...cachedUsage, output_tokens: 3 } };
        const events = convert([cachedStart, text(0, 'answer'), cumulativeUsage, finish(), end], protocol);
        const usage = protocol === 'openai' ? events.at(-1).usage : events.at(-1).response.usage;
        const totalInput = protocol === 'openai' ? usage.prompt_tokens : usage.input_tokens;
        const cached = protocol === 'openai' ? usage.prompt_tokens_details.cached_tokens : usage.input_tokens_details.cached_tokens;
        expect(totalInput).toBe(1042);
        expect(cached).toBe(1024);
        expect(totalInput - cached).toBe(18);
        expect(usage.total_tokens).toBe(1050);
    });

    test.each(['openai', 'openaiResponses'])('%s actual AI SDK receives nonnegative uncached input tokens', async protocol => {
        const cachedStart = { ...start, message: { ...start.message, usage: cachedUsage } };
        const events = convert([cachedStart, text(0, 'answer'), finish(), end], protocol);
        let sse = events.map(event => `${protocol === 'openaiResponses' ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('');
        if (protocol === 'openai') sse += 'data: [DONE]\n\n';
        const client = createOpenAI({
            apiKey: 'mock-only',
            fetch: jest.fn(async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }))
        });
        const sdkModel = protocol === 'openai' ? client.chat(model) : client.responses(model);
        const result = await sdkModel.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
        const parsed = [];
        for await (const event of result.stream) parsed.push(event);
        expect(parsed.filter(event => event.type === 'error')).toEqual([]);
        const final = parsed.find(event => event.type === 'finish');
        expect(final.usage.inputTokens).toMatchObject({ total: 1042, cacheRead: 1024, noCache: 18 });
        expect(final.usage.raw.total_tokens).toBe(1050);
    });

    test('the initial chat chunk uses the same total input and cached token definitions', () => {
        const cachedStart = { ...start, message: { ...start.message, usage: cachedUsage } };
        const first = convert([cachedStart, finish(), end])[0];
        expect(first.usage).toMatchObject({
            prompt_tokens: 1042, total_tokens: 1042, completion_tokens: 0,
            cached_tokens: 1024, prompt_tokens_details: { cached_tokens: 1024 }
        });
    });

    test.each(['openai', 'openaiResponses'])('%s non-streaming uses the same cached totals for populated and empty content', protocol => {
        for (const content of [[], [{ type: 'text', text: 'answer' }]]) {
            const converter = new ClaudeConverter();
            const response = converter.convertResponse({ id: 'cached', content, stop_reason: 'end_turn', usage: { ...cachedUsage, output_tokens: 8 } }, protocol, model);
            expect(response.usage.total_tokens).toBe(1050);
            expect(protocol === 'openai' ? response.usage.prompt_tokens : response.usage.input_tokens).toBe(1042);
        }
    });

    test.each(['openai', 'openaiResponses'])('%s absent cache counters retain ordinary token totals', protocol => {
        const events = convert([start, text(0, 'answer'), finish(), end], protocol);
        const usage = protocol === 'openai' ? events.at(-1).usage : events.at(-1).response.usage;
        expect(usage.total_tokens).toBe(20);
        expect(protocol === 'openai' ? usage.prompt_tokens : usage.input_tokens).toBe(12);
    });
});
