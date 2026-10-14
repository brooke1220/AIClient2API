import { getEventListeners } from 'node:events';
import * as http from 'node:http';
import { Readable } from 'node:stream';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { KiroToolAssembler } from '../src/providers/claude/kiro-tool-assembler.js';
import { collect, frame, model, request, service, text, tool, bounded } from './helpers/kiro-safety-fixtures.js';

const thinking = { type: 'enabled', budget_tokens: 1024 };
const toolRequest = () => ({ ...request(), tools: [{ name: 'read_file', input_schema: { type: 'object' } }] });
const stoppedTool = () => tool({ name: 'read_file', toolUseId: 't1', input: '{"path":"README.md"}', stop: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function blocksFromEvents(events) {
    const blocks = new Map();
    for (const event of events) {
        if (event.type === 'content_block_start') blocks.set(event.index, { ...event.content_block });
        if (event.delta?.type === 'text_delta') blocks.get(event.index).text += event.delta.text;
        if (event.delta?.type === 'thinking_delta') blocks.get(event.index).thinking += event.delta.thinking;
        if (event.delta?.type === 'input_json_delta') {
            const block = blocks.get(event.index);
            block.arguments = (block.arguments || '') + event.delta.partial_json;
        }
    }
    return [...blocks.values()].map(block => {
        if (block.type === 'tool_use') { block.input = JSON.parse(block.arguments || '{}'); delete block.arguments; }
        return block;
    });
}

async function output(frames, body, mode, config = {}) {
    const backend = service(frames, config);
    if (mode === 'unary') return await backend.generateContent(model, body);
    const events = await collect(backend.generateContentStream(model, body));
    return { content: blocksFromEvents(events), ...events.find(event => event.type === 'message_delta').delta, events };
}

function expectSerialBlocks(events) {
    let active = null;
    for (const event of events || []) {
        if (event.type === 'content_block_start') { expect(active).toBeNull(); active = event.index; }
        if (event.type === 'content_block_delta') expect(event.index).toBe(active);
        if (event.type === 'content_block_stop') { expect(event.index).toBe(active); active = null; }
    }
    expect(active).toBeNull();
}

describe('Kiro review regressions', () => {
    afterEach(() => jest.restoreAllMocks());

    test('argument byte accounting visits only new fragments, not growing prefixes', () => {
        const input = JSON.stringify({ text: 'x'.repeat(16 * 1024) });
        const original = Buffer.byteLength;
        let scannedBytes = 0;
        jest.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => {
            const length = original(value, encoding); scannedBytes += length; return length;
        });
        const assembler = new KiroToolAssembler();
        assembler.feed({ name: 'write', toolUseId: 't' });
        for (let offset = 0; offset < input.length; offset += 32) {
            assembler.feed({ toolUseId: 't', input: input.slice(offset, offset + 32) });
        }
        expect(assembler.feed({ toolUseId: 't', stop: true })[0].arguments).toBe(input);
        expect(scannedBytes).toBeLessThanOrEqual(input.length * 2);
    });

    test('incremental byte budgets count a split surrogate pair exactly', () => {
        const input = '{"value":"😀"}';
        const assembler = new KiroToolAssembler(Buffer.byteLength(input));
        for (const [index, fragment] of input.split('').entries()) {
            assembler.feed({ ...(index === 0 ? { name: 'write', toolUseId: 't' } : { toolUseId: 't' }), input: fragment });
        }
        expect(assembler.bytes).toBe(Buffer.byteLength(input));
        expect(assembler.feed({ toolUseId: 't', stop: true })[0].input).toEqual({ value: '😀' });
    });

    test('object snapshots replace the previous cached byte contribution', () => {
        const assembler = new KiroToolAssembler(100);
        assembler.feed({ name: 'a', toolUseId: 'a', input: '{"partial":' });
        assembler.feed({ name: 'b', toolUseId: 'b', input: '{"b":1}', stop: true });
        const result = assembler.feed({ toolUseId: 'a', input: { a: 2 }, stop: true });
        expect(result.map(call => call.input)).toEqual([{ a: 2 }, { b: 1 }]);
        expect(assembler.bytes).toBe(Buffer.byteLength('{"a":2}{"b":1}'));
    });

    test.each(['unary', 'stream'])('%s supplies nullable Claude stop fields and preserves a real stop sequence', async mode => {
        const plain = await output([text('hello')], request(), mode);
        expect(plain).toMatchObject({ stop_reason: 'end_turn', stop_sequence: null });
        if (plain.events) expect(plain.events[0].message).toMatchObject({ stop_reason: null, stop_sequence: null });
        const stopped = await output([text('hello'), frame('metadataEvent', { stopReason: 'stop_sequence', stopSequence: 'END' })], request(), mode);
        expect(stopped).toMatchObject({ stop_reason: 'stop_sequence', stop_sequence: 'END' });
    });

    test.each(['unary', 'stream'])('%s keeps buffered text before a tool in thinking mode', async mode => {
        const result = await output([text('ABCDE'), stoppedTool()], { ...toolRequest(), thinking }, mode);
        expect(result.content.map(block => block.type)).toEqual(['text', 'tool_use']);
        expect(result.content[0].text).toBe('ABCDE');
        expect(result.content[1].input).toEqual({ path: 'README.md' });
        expectSerialBlocks(result.events);
    });

    test.each(['unary', 'stream'])('%s flushes all inline thinking before a tool boundary', async mode => {
        const thought = 'I should read the requested file';
        const result = await output([text(`<thinking>${thought}`), stoppedTool()], { ...toolRequest(), thinking }, mode);
        expect(result.content.map(block => block.type)).toEqual(['thinking', 'tool_use']);
        expect(result.content[0].thinking).toBe(thought);
        expectSerialBlocks(result.events);
    });

    test('a native reasoning transition flushes preceding buffered text', async () => {
        const result = await output([text('ABCDE'), frame('reasoningContentEvent', { text: 'reason' }), text('answer')], { ...request(), thinking }, 'stream');
        expect(result.content.map(block => block.type)).toEqual(['text', 'thinking', 'text']);
        expect(result.content.map(block => block.text || block.thinking)).toEqual(['ABCDE', 'reason', 'answer']);
        expectSerialBlocks(result.events);
    });

    test.each(['unary', 'stream'])('%s restores split bracket tool calls without leaking their wire markers', async mode => {
        const marker = '[Called read_file with args: {"path":"README.md","nested":["]",{"x":1}]}]';
        const frames = [text('before '), ...marker.match(/.{1,3}/g).map(text), text(' after')];
        const result = await output(frames, toolRequest(), mode);
        expect(result.content.map(block => block.type)).toEqual(['text', 'tool_use', 'text']);
        expect(result.content[0].text).toBe('before ');
        expect(result.content[1]).toMatchObject({ name: 'read_file', input: { path: 'README.md', nested: [']', { x: 1 }] } });
        expect(result.content[2].text).toBe(' after');
        expect(result.stop_reason).toBe('tool_use');
        expectSerialBlocks(result.events);
    });

    test.each(['unary', 'stream'])('%s legacy calls obey the same byte and call-count budgets as native tools', async mode => {
        await expect(output([text('[Called read_file with args: {"path":"README.md"}]')], toolRequest(), mode, { KIRO_MAX_TOOL_ARGUMENT_BYTES: 8 })).rejects.toThrow(/limit/);
        await expect(output([text('[Called read_file with args: {"path":"a"}][Called read_file with args: {"path":"b"}]')], toolRequest(), mode, { KIRO_MAX_TOOL_CALLS: 1 })).rejects.toThrow(/count limit/);
    });

    test.each(['unary', 'stream'])('%s does not repair or execute malformed/truncated bracket arguments', async mode => {
        for (const marker of ['[Called read_file with args: {"path":}]', '[Called read_file with args: {"path":"cut', '[Called read_file with args: []]']) {
            await expect(output([text(marker)], toolRequest(), mode)).rejects.toMatchObject({ status: 502, skipErrorCount: true });
        }
    });

    test.each(['unary', 'stream'])('%s deduplicates native/bracket representations without dropping separate native IDs', async mode => {
        const marker = '[Called read_file with args: {"path":"README.md"}]';
        for (const frames of [[stoppedTool(), text(marker)], [text(marker), stoppedTool()]]) {
            const result = await output(frames, toolRequest(), mode);
            expect(result.content.filter(block => block.type === 'tool_use')).toHaveLength(1);
        }
        const result = await output([stoppedTool(), tool({ name: 'read_file', toolUseId: 't2', input: '{"path":"README.md"}', stop: true })], toolRequest(), mode);
        expect(result.content.filter(block => block.type === 'tool_use').map(block => block.id)).toEqual(['t1', 't2']);
    });

    test.each(['unary', 'stream'])('%s treats quoted, code-block, and undeclared-tool markers as literal text', async mode => {
        const marker = '[Called read_file with args: {"path":"README.md"}]';
        for (const source of [`\`${marker}\``, `\"${marker}\"`, `\"example: ${marker}\"`, `'example: ${marker}'`,
            `“示例：${marker}”`, `‘示例：${marker}’`, `\`\`\`\n${marker}\n\`\`\``, `~~~\n${marker}\n~~~`,
            `\\${marker}`, '[Called unknown with args: {}]']) {
            const result = await output(source.split('').map(text), toolRequest(), mode);
            expect(result.content.every(block => block.type === 'text')).toBe(true);
            expect(result.content.map(block => block.text).join('')).toBe(source);
            expect(result.stop_reason).toBe('end_turn');
        }
        const result = await output([text(marker)], request(), mode);
        expect(result.content).toEqual([{ type: 'text', text: marker }]);
    });

    test('bracket markers in thinking never turn into executable tool calls', async () => {
        const result = await output([text('<thinking>[Called read_file with args: {}]</thinking>\n\nanswer')], { ...toolRequest(), thinking }, 'unary');
        expect(result.content.map(block => block.type)).toEqual(['thinking', 'text']);
    });

    test('an incomplete marker prefix at EOF remains literal text', async () => {
        const result = await output([text('value [Ca')], toolRequest(), 'unary');
        expect(result.content).toEqual([{ type: 'text', text: 'value [Ca' }]);
    });

    test.each(['unary', 'stream'])('%s keeps buffered text before a tool that is finalized at EOF', async mode => {
        const result = await output([text('ABCDE'), tool({ name: 'read_file', toolUseId: 't1', input: '{}' })], { ...toolRequest(), thinking }, mode);
        expect(result.content.map(block => block.type)).toEqual(['text', 'tool_use']);
        expect(result.content[0].text).toBe('ABCDE');
        expectSerialBlocks(result.events);
    });

    test('a tool boundary prevents a held backslash from joining text on the other side', async () => {
        const result = await output([text('before\\'), stoppedTool(), text('n after')], toolRequest(), 'stream');
        expect(result.content.map(block => block.type)).toEqual(['text', 'tool_use', 'text']);
        expect(result.content[0].text).toBe('before\\');
        expect(result.content[2].text).toBe('n after');
        expectSerialBlocks(result.events);
    });

    test('legacy text cannot take over an unfinished native call with a delayed real ID', async () => {
        const result = await output([
            tool({ name: 'read_file', input: '{"path":' }),
            text('[Called read_file with args: {"path":"legacy"}]'),
            tool({ toolUseId: 'real', input: '"native"}', stop: true })
        ], toolRequest(), 'stream');
        const calls = result.content.filter(block => block.type === 'tool_use');
        expect(calls.map(block => block.input)).toEqual([{ path: 'native' }, { path: 'legacy' }]);
        expect(calls[0].id).toBe('real');
        expectSerialBlocks(result.events);
    });

    test('unknown Unicode marker headers remain text even with a tiny tool argument budget', async () => {
        const value = '[Called ' + '中'.repeat(1024) + ' text]';
        const result = await output([text(value)], toolRequest(), 'unary', { KIRO_MAX_TOOL_ARGUMENT_BYTES: 1 });
        expect(result.content).toEqual([{ type: 'text', text: value }]);
    });

    test('native fragments and a pending legacy call share one argument storage budget', async () => {
        await expect(output([
            tool({ name: 'read_file', toolUseId: 'a', input: '{"path":"' }),
            text('[Called read_file with args: {"path":"legacy'),
            tool({ toolUseId: 'a', input: 'native"}' })
        ], toolRequest(), 'unary', { KIRO_MAX_TOOL_ARGUMENT_BYTES: 30 })).rejects.toThrow(/limit/);
    });

    test('one wire delta cannot stage multiple parsed tools beyond the shared budget', async () => {
        const first = '{"path":"abcdef"}';
        const second = '{"path":"second-abcdef"}';
        const parse = jest.spyOn(JSON, 'parse');
        await expect(output([text(`[Called read_file with args: ${first}][Called read_file with args: ${second}]`)],
            toolRequest(), 'unary', { KIRO_MAX_TOOL_ARGUMENT_BYTES: 30 })).rejects.toThrow(/limit/);
        expect(parse.mock.calls.some(([value]) => value === second)).toBe(false);
    });

    test('legacy no-op placeholders do not fabricate a successful tool response', async () => {
        await expect(output([text('[Called no_tool_available with args: {}]')], request(), 'unary')).rejects.toMatchObject({ isEmptyUpstreamResponse: true });
    });

    test('legacy markers restore shortened requested tool names', async () => {
        const name = 'mcp_' + 'long_tool_name_'.repeat(8);
        const body = { ...request(), tools: [{ name, input_schema: { type: 'object' } }] };
        const backend = service();
        backend.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
        const built = await backend.buildCodewhispererRequest(body.messages, model, body.tools);
        const alias = built._kiroToolNameMaps.toKiroName(name);
        expect(alias).not.toBe(name);
        backend._requestWithBuilderEndpointRouting.mockImplementation(async () => ({ data: Readable.from([text(`[Called ${alias} with args: {}]`)]) }));
        const result = await backend.generateContent(model, body);
        expect(result.content).toEqual([expect.objectContaining({ type: 'tool_use', name, input: {} })]);
    });

    test('invalid stop-sequence metadata fails rather than corrupting the Claude schema', async () => {
        await expect(output([text('answer'), frame('metadataEvent', { stopReason: 'stop_sequence', stopSequence: 123 })], request(), 'unary')).rejects.toMatchObject({ status: 502, skipErrorCount: true });
    });

    test.each(['<thinking>', '<thinking></thinking>'])('empty inline thinking %s keeps the empty-response retry window open', async source => {
        const backend = service([text(source)]);
        await expect(backend.generateContentStream(model, { ...request(), thinking }).next()).rejects.toMatchObject({ isEmptyUpstreamResponse: true });
    });
});

describe('Kiro review HTTP timeout regressions', () => {
    const createBackend = async (port, config) => {
        const backend = service([], config);
        backend.isInitialized = false; backend.loadCredentials = jest.fn(async () => {});
        await backend.initialize();
        backend.baseUrl = `http://127.0.0.1:${port}/generateAssistantResponse`;
        backend.axiosInstance.defaults.timeout = 20; // Scale down the inherited 120s timeout.
        backend._applySidecar = config => { config.proxy = false; };
        backend._requestWithBuilderEndpointRouting = KiroApiService.prototype._requestWithBuilderEndpointRouting;
        return backend;
    };

    async function localServer(handler, operation) {
        const timers = new Set();
        const later = callback => { const timer = setTimeout(callback, 90); timers.add(timer); };
        const server = http.createServer((req, res) => {
            req.resume(); req.on('end', () => handler(res, later));
        });
        try {
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
            await operation(server.address().port);
        } finally {
            for (const timer of timers) clearTimeout(timer);
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    }

    test.each([
        { KIRO_FIRST_EVENT_TIMEOUT_MS: 0, KIRO_STREAM_IDLE_TIMEOUT_MS: 0, KIRO_STREAM_TOTAL_TIMEOUT_MS: 0 },
        { KIRO_FIRST_EVENT_TIMEOUT_MS: 200, KIRO_STREAM_IDLE_TIMEOUT_MS: 200, KIRO_STREAM_TOTAL_TIMEOUT_MS: 0 }
    ])('disabled or extended idle deadlines are not capped by Axios defaults: %p', async config => {
        await localServer((res, later) => {
            res.writeHead(200); res.write(text('prefix'));
            later(() => res.end(text('suffix')));
        }, async port => {
            const backend = await createBackend(port, config);
            const result = await bounded(backend.generateContent(model, request()), 2000);
            expect(result.content).toEqual([{ type: 'text', text: 'prefixsuffix' }]);
        });
    });

    test('an extended first-event deadline is not capped by Axios defaults', async () => {
        await localServer((res, later) => {
            res.writeHead(200); res.flushHeaders(); later(() => res.end(text('answer')));
        }, async port => {
            const backend = await createBackend(port, { KIRO_FIRST_EVENT_TIMEOUT_MS: 200, KIRO_STREAM_IDLE_TIMEOUT_MS: 0 });
            expect((await bounded(backend.generateContent(model, request()), 2000)).content[0].text).toBe('answer');
        });
    });

    test('a real HTTP transport survives consumer backpressure longer than its inherited timeout', async () => {
        let upstreamResponse;
        await localServer(res => { upstreamResponse = res; res.writeHead(200); res.write(text('prefix')); }, async port => {
            const backend = await createBackend(port, { KIRO_FIRST_EVENT_TIMEOUT_MS: 200, KIRO_STREAM_IDLE_TIMEOUT_MS: 30 });
            const controller = new AbortController();
            const iterator = backend.streamApiReal('', model, request(), false, 0, { signal: controller.signal });
            try {
                expect((await bounded(iterator.next())).value.content).toBe('prefix');
                await sleep(90); expect(upstreamResponse.destroyed).toBe(false);
                upstreamResponse.end(text('suffix'));
                expect((await bounded(iterator.next())).value.content).toBe('suffix');
                expect((await bounded(iterator.next())).done).toBe(true);
                expect(controller.signal.aborted).toBe(false);
                expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
            } finally { controller.abort(); await iterator.return(); }
        });
    });
});
