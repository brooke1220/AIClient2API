import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import '../src/converters/register-converters.js';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { ConverterFactory } from '../src/converters/ConverterFactory.js';
import { toOpenAIStreamChunkFromClaude } from '../src/convert/convert.js';
import { handleStreamRequest } from '../src/utils/common.js';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { KiroApiServiceAdapter } from '../src/providers/adapter.js';

const model = 'claude-sonnet-4-5';
const start = id => ({ type: 'message_start', message: { id, model, usage: { input_tokens: 12, output_tokens: 0 } } });
const block = (index, content_block) => ({ type: 'content_block_start', index, content_block });
const text = (index, value) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } });
const thinking = (index, value) => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: value } });
const args = (index, value) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: value } });
const stop = index => ({ type: 'content_block_stop', index });
const finish = (reason = 'end_turn') => ({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 8 } });
const end = { type: 'message_stop' };

function convert(chunks, protocol, requestId = 'test-request', converter = new ClaudeConverter()) {
    return chunks.flatMap(chunk => {
        const result = converter.convertStreamChunk(chunk, protocol, model, requestId);
        return result ? (Array.isArray(result) ? result : [result]) : [];
    });
}

// Mimic a strict client: deltas must refer to a previously announced item at
// the same output_index. Its accumulated text must agree with terminal events.
function replayResponses(events) {
    const items = new Map();
    const textById = new Map(), reasoningById = new Map(), argsById = new Map();
    events.forEach((event, sequence) => {
        expect(event.sequence_number).toBe(sequence);
        if (event.type === 'response.output_item.added') {
            expect(items.has(event.output_index)).toBe(false);
            items.set(event.output_index, event.item.id);
            expect(event.item.status).toBe('in_progress');
        }
        if (event.item_id) expect(items.get(event.output_index)).toBe(event.item_id);
        if (event.type === 'response.output_text.delta') textById.set(event.item_id, (textById.get(event.item_id) || '') + event.delta);
        if (event.type === 'response.reasoning_summary_text.delta') reasoningById.set(event.item_id, (reasoningById.get(event.item_id) || '') + event.delta);
        if (event.type === 'response.function_call_arguments.delta') argsById.set(event.item_id, (argsById.get(event.item_id) || '') + event.delta);
        if (event.type === 'response.output_text.done') expect(event.text).toBe(textById.get(event.item_id));
        if (event.type === 'response.reasoning_summary_text.done') expect(event.text).toBe(reasoningById.get(event.item_id));
        if (event.type === 'response.function_call_arguments.done') expect(event.arguments).toBe(argsById.get(event.item_id));
        if (event.type === 'response.output_item.done') expect(items.get(event.output_index)).toBe(event.item.id);
    });
    const terminal = events.at(-1);
    expect(['response.completed', 'response.incomplete']).toContain(terminal.type);
    expect(terminal.response.output.map(item => item.id)).toEqual([...items.values()]);
    return { terminal, textById, reasoningById, argsById };
}

function mockResponse() {
    const response = new EventEmitter();
    response.writableEnded = false;
    response.writeHead = jest.fn();
    response.flushHeaders = jest.fn();
    response.write = jest.fn(() => true);
    response.end = jest.fn(() => { response.writableEnded = true; });
    return response;
}

async function runHandler(chunks, protocol, response = mockResponse(), serviceOverride = null) {
    const service = serviceOverride || {
        generateContentStream: () => (async function* () {
            for (const chunk of chunks) {
                if (chunk instanceof Error) throw chunk;
                if (typeof chunk === 'function') { await chunk(); continue; }
                yield chunk;
            }
        })()
    };
    await handleStreamRequest(response, service, model, { messages: [{ role: 'user', content: 'hello' }] }, protocol, 'claude-kiro-oauth', 'none', null, null, null, null,
        { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 0 }, maxRetries: 0 });
    return response;
}

const adjacentText = [
    start('native-message'), block(4, { type: 'text', text: '' }),
    text(4, 'Checking the test harn'), text(4, 'ess first.'), stop(4),
    block(8, { type: 'text', text: '' }), text(8, ' 这里只修这个 b'), text(8, 'ug。'), stop(8), finish(), end
];
const joinedText = 'Checking the test harness first. 这里只修这个 bug。';

describe('Claude/Kiro → OpenAI stream identities', () => {
    afterEach(() => jest.restoreAllMocks());

    test('split words across deltas and adjacent blocks retain one completion id', () => {
        const events = convert(adjacentText, 'openai');
        expect(new Set(events.map(event => event.id)).size).toBe(1);
        expect(events.map(event => event.choices[0].delta.content || '').join('')).toBe(joinedText);
        expect(events.filter(event => event.choices[0].finish_reason)).toHaveLength(1);
    });

    test('creation time stays stable across chunks', () => {
        const converter = new ClaudeConverter();
        const clock = jest.spyOn(Date, 'now').mockReturnValue(100000);
        const first = converter.convertStreamChunk(start('clock'), 'openai', model, 'clock-request');
        clock.mockReturnValue(200000);
        const second = converter.convertStreamChunk(text(0, 'continuation'), 'openai', model, 'clock-request');
        expect(second.id).toBe(first.id);
        expect(second.created).toBe(first.created);
        converter.convertStreamChunk(end, 'openai', model, 'clock-request');
    });

    test('tool indexes are dense and do not reuse raw text/thinking block indexes', () => {
        const events = convert([
            start('tools'), block(0, { type: 'thinking' }), thinking(0, 'plan'), stop(0),
            block(1, { type: 'text' }), text(1, 'checking'), stop(1),
            block(3, { type: 'tool_use', id: 'tool-a', name: 'read' }),
            block(7, { type: 'tool_use', id: 'tool-b', name: 'search' }),
            args(3, '{"a":1}'), args(7, '{"b":2}'), stop(3), stop(7), finish('tool_use'), end
        ], 'openai');
        const calls = events.flatMap(event => event.choices[0].delta.tool_calls || []);
        expect(calls.filter(call => call.id).map(call => call.index)).toEqual([0, 1]);
        expect(calls.filter(call => !call.id).map(call => call.index)).toEqual([0, 1]);
        expect(events.at(-1).choices[0].finish_reason).toBe('tool_calls');
        expect(new Set(events.map(event => event.id)).size).toBe(1);
    });

    test('usage-only deltas do not prematurely finish the assistant message', () => {
        const converter = new ClaudeConverter();
        converter.convertStreamChunk(start('usage'), 'openai', model, 'usage-request');
        const usage = converter.convertStreamChunk({ type: 'message_delta', delta: {}, usage: { output_tokens: 4 } }, 'openai', model, 'usage-request');
        expect(usage.choices[0].finish_reason).toBeNull();
        expect(usage.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
        converter.convertStreamChunk(end, 'openai', model, 'usage-request');
    });

    test('concurrent requests and compatibility entry points preserve separate identities', () => {
        const converter = ConverterFactory.getConverter('claude');
        const a = toOpenAIStreamChunkFromClaude(start('a'), model, 'compat-a');
        const b = toOpenAIStreamChunkFromClaude(start('b'), model, 'compat-b');
        expect(a.id).not.toBe(b.id);
        expect(toOpenAIStreamChunkFromClaude(text(0, 'a text'), model, 'compat-a').id).toBe(a.id);
        toOpenAIStreamChunkFromClaude(end, model, 'compat-a');
        expect(toOpenAIStreamChunkFromClaude(text(0, 'b text'), model, 'compat-b').id).toBe(b.id);
        toOpenAIStreamChunkFromClaude(end, model, 'compat-b');
        expect(converter.openAIStreamStateCount()).toBe(0);
    });
});

describe('Claude/Kiro → Responses item lifecycle', () => {
    test('adjacent text blocks append to a single item without waiting for the whole response', () => {
        const converter = new ClaudeConverter();
        const firstHalf = convert(adjacentText.slice(0, 4), 'openaiResponses', 'adjacent', converter);
        expect(firstHalf.some(event => event.type === 'response.output_text.delta')).toBe(true);
        const events = [...firstHalf, ...convert(adjacentText.slice(4), 'openaiResponses', 'adjacent', converter)];
        const { terminal, textById } = replayResponses(events);
        expect([...textById.values()]).toEqual([joinedText]);
        expect(terminal.response.output).toHaveLength(1);
    });

    test('reasoning and visible text occupy different indexes without phantom messages', () => {
        const events = convert([
            start('thinking-first'), block(0, { type: 'thinking', thinking: '' }), thinking(0, 'plan'), stop(0),
            block(1, { type: 'text', text: '' }), text(1, 'answer'), stop(1), finish(), end
        ], 'openaiResponses');
        const { terminal } = replayResponses(events);
        const added = events.filter(event => event.type === 'response.output_item.added');
        expect(added.map(event => [event.output_index, event.item.type])).toEqual([[0, 'reasoning'], [1, 'message']]);
        expect(terminal.response.output.map(item => item.type)).toEqual(['reasoning', 'message']);
        expect(terminal.response.usage).toMatchObject({ input_tokens: 12, output_tokens: 8, total_tokens: 20 });
    });

    test('text/tool/text boundaries stay ordered without merging across actual tool calls', () => {
        const events = convert([
            start('ordered'), block(2, { type: 'text' }), text(2, 'before tool'), stop(2),
            block(4, { type: 'tool_use', id: 'tool-a', name: 'read', input: {} }), args(4, '{"path":"a"}'), stop(4),
            block(9, { type: 'text' }), text(9, 'after tool'), stop(9), finish('tool_use'), end
        ], 'openaiResponses');
        const { terminal } = replayResponses(events);
        expect(terminal.response.output.map(item => item.type)).toEqual(['message', 'function_call', 'message']);
        expect(terminal.response.output[1]).toMatchObject({ call_id: 'tool-a', name: 'read', arguments: '{"path":"a"}' });
        expect(terminal.response.status).toBe('completed');
    });

    test('parallel tool arguments and completion use the corresponding item/index', () => {
        const events = convert([
            start('parallel'), block(3, { type: 'tool_use', id: 'a', name: 'read' }),
            block(8, { type: 'tool_use', id: 'b', name: 'search' }),
            args(3, '{"a":'), args(8, '{"b":'), args(3, '1}'), stop(3), args(8, '2}'), stop(8), finish('tool_use'), end
        ], 'openaiResponses');
        const { terminal } = replayResponses(events);
        expect(terminal.response.output.map(item => [item.call_id, item.arguments])).toEqual([['a', '{"a":1}'], ['b', '{"b":2}']]);
    });

    test.each(['reasoning', 'tool'])('%s-only replies do not invent an empty assistant message', type => {
        const chunks = type === 'reasoning'
            ? [block(0, { type: 'thinking' }), thinking(0, 'plan'), stop(0)]
            : [block(0, { type: 'tool_use', id: 'a', name: 'read', input: {} }), stop(0)];
        const events = convert([start(type), ...chunks, finish(type === 'tool' ? 'tool_use' : 'end_turn'), end], 'openaiResponses');
        const { terminal } = replayResponses(events);
        expect(terminal.response.output).toHaveLength(1);
        expect(terminal.response.output[0].type).toBe(type === 'tool' ? 'function_call' : 'reasoning');
    });

    test('interleaved thinking/text preserves meaningful boundaries and content', () => {
        const events = convert([
            start('interleaved'), block(0, { type: 'thinking' }), thinking(0, 'plan 1'), stop(0),
            block(1, { type: 'text' }), text(1, 'text 1'), stop(1),
            block(2, { type: 'thinking' }), thinking(2, 'plan 2'), stop(2),
            block(3, { type: 'text' }), text(3, 'text 2'), stop(3), finish(), end
        ], 'openaiResponses');
        const { terminal } = replayResponses(events);
        expect(terminal.response.output.map(item => item.type)).toEqual(['reasoning', 'message', 'reasoning', 'message']);
    });

    test('initial text, thinking, and complete tool input are not lost', () => {
        const events = convert([
            start('initial'), block(0, { type: 'thinking', thinking: 'initial plan' }), stop(0),
            block(1, { type: 'text', text: 'initial text' }), stop(1),
            block(2, { type: 'tool_use', id: 'tool', name: 'read', input: { path: 'a' } }), stop(2), finish('tool_use'), end
        ], 'openaiResponses');
        const { terminal } = replayResponses(events);
        expect(terminal.response.output[0].summary[0].text).toBe('initial plan');
        expect(terminal.response.output[1].content[0].text).toBe('initial text');
        expect(JSON.parse(terminal.response.output[2].arguments)).toEqual({ path: 'a' });
    });

    test('empty native text blocks before tools do not create placeholder messages', () => {
        const events = convert([
            start('empty-text'), block(0, { type: 'text', text: '' }), text(0, ''), stop(0),
            block(2, { type: 'tool_use', id: 'tool', name: 'read', input: {} }), stop(2), finish('tool_use'), end
        ], 'openaiResponses');
        const { terminal } = replayResponses(events);
        expect(terminal.response.output.map(item => item.type)).toEqual(['function_call']);
    });

    test('completed output matches item-done snapshots including ordering and content', () => {
        const events = convert(adjacentText, 'openaiResponses');
        const { terminal } = replayResponses(events);
        expect(events.filter(event => event.type === 'response.output_item.done').map(event => event.item)).toEqual(terminal.response.output);
        const added = events.find(event => event.type === 'response.output_item.added');
        expect(added.item.content).toEqual([]);
        expect(added.item.status).toBe('in_progress');
        expect(terminal.response.output[0].content[0].text).toBe(joinedText);
    });

    test('token-limit termination is incomplete rather than a successful completed response', () => {
        const events = convert([start('limited'), block(0, { type: 'text' }), text(0, 'partial'), stop(0), finish('max_tokens'), end], 'openaiResponses');
        const { terminal } = replayResponses(events);
        expect(terminal.type).toBe('response.incomplete');
        expect(terminal.response).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    });
});

describe('real streaming handler preserves message boundaries and clears state', () => {
    const converter = ConverterFactory.getConverter('claude');
    beforeEach(() => {
        converter.openAIStreamStates?.clear();
        converter.openAIResponsesStreamStates?.clear();
    });

    test.each(['openai', 'openaiResponses'])('SSE %s keeps split words in their original message', async protocol => {
        const response = await runHandler(adjacentText, protocol);
        const payloads = response.write.mock.calls.flatMap(([value]) => {
            if (!value.startsWith('data: ') || value.includes('[DONE]')) return [];
            return [JSON.parse(value.slice(6))];
        });
        if (protocol === 'openai') {
            expect(new Set(payloads.map(event => event.id)).size).toBe(1);
            expect(payloads.map(event => event.choices[0].delta.content || '').join('')).toBe(joinedText);
        } else {
            expect([...replayResponses(payloads).textById.values()]).toEqual([joinedText]);
        }
        expect(converter.openAIStreamStateCount()).toBe(0);
    });

    test.each(['openai', 'openaiResponses'])('Kiro service → adapter → SSE %s preserves split words and tool boundaries', async protocol => {
        const service = Object.create(KiroApiService.prototype);
        Object.assign(service, {
            config: {}, isInitialized: true,
            _prepareAccessTokenForRequest: async () => {},
            estimateInputTokens: () => 12, countTextTokens: value => value.length,
            streamApiReal: async function* () {
                yield { type: 'reasoning', reasoning: 'checking the request' };
                yield { type: 'content', content: 'Checking the test harn' };
                yield { type: 'content', content: 'ess first.' };
                yield { type: 'toolUse', toolUse: { name: 'read', toolUseId: 'tool-a', input: '', stop: false } };
                yield { type: 'toolUseInput', input: '{"path":"a"}' };
                yield { type: 'toolUseStop', stop: true };
            }
        });
        const adapter = Object.create(KiroApiServiceAdapter.prototype);
        adapter.kiroApiService = service;
        const response = await runHandler([], protocol, mockResponse(), adapter);
        const payloads = response.write.mock.calls.flatMap(([value]) => {
            if (!value.startsWith('data: ') || value.includes('[DONE]')) return [];
            return [JSON.parse(value.slice(6))];
        });
        if (protocol === 'openai') {
            expect(new Set(payloads.map(event => event.id)).size).toBe(1);
            expect(payloads.map(event => event.choices[0].delta.content || '').join('')).toBe('Checking the test harness first.');
            expect(payloads.flatMap(event => event.choices[0].delta.tool_calls || []).filter(call => call.id).map(call => call.index)).toEqual([0]);
        } else {
            const { terminal, textById } = replayResponses(payloads);
            expect([...textById.values()]).toEqual(['Checking the test harness first.']);
            expect(terminal.response.output.map(item => item.type)).toEqual(['reasoning', 'message', 'function_call']);
            expect(terminal.response.output[2]).toMatchObject({ call_id: 'tool-a', name: 'read', arguments: '{"path":"a"}' });
        }
        expect(converter.openAIStreamStateCount()).toBe(0);
    });

    test.each(['openai', 'openaiResponses'])('%s state is cleared on disconnect, throw, and missing-stop EOF', async protocol => {
        for (const failure of ['disconnect', 'throw', 'eof']) {
            const response = mockResponse();
            const chunks = [start(failure), block(0, { type: 'text' }), text(0, 'prefix')];
            if (failure === 'disconnect') chunks.push(() => response.emit('close'), text(0, 'not sent'));
            if (failure === 'throw') chunks.push(new Error('mock upstream failure'));
            await runHandler(chunks, protocol, response);
            expect(converter.openAIStreamStateCount()).toBe(0);
        }
    });

    test('finishing one Responses stream does not reset a concurrent stream', () => {
        const a = converter.convertStreamChunk(start('a'), 'openaiResponses', model, 'request-a');
        const b = converter.convertStreamChunk(start('b'), 'openaiResponses', model, 'request-b');
        expect(a[0].response.id).not.toBe(b[0].response.id);
        converter.convertStreamChunk(text(0, 'alpha'), 'openaiResponses', model, 'request-a');
        converter.convertStreamChunk(end, 'openaiResponses', model, 'request-a');
        const tail = converter.convertStreamChunk(text(0, 'beta'), 'openaiResponses', model, 'request-b');
        expect(tail.find(event => event.type === 'response.output_text.delta').delta).toBe('beta');
        const done = converter.convertStreamChunk(end, 'openaiResponses', model, 'request-b');
        expect(done.at(-1).response.output[0].content[0].text).toBe('beta');
        expect(converter.openAIStreamStateCount()).toBe(0);
    });
});
