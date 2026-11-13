import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { KiroApiServiceAdapter } from '../src/providers/adapter.js';
import { resolveKiroToolStreamMode } from '../src/providers/claude/kiro-tool-stream.js';
import { collect, frame, model, request, service, text, tool, openStream, bounded, tick } from './helpers/kiro-safety-fixtures.js';

const eligible = () => ({ kiroTiming: { toolGate: true } });
const configured = frames => service(frames, { KIRO_TOOL_STREAM_MODE: 'incremental' });
const args = events => events.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json);
const starts = events => events.filter(event => event.content_block?.type === 'tool_use');
const toolBody = () => ({ ...request(), tools: [{ name: 'write', input_schema: { type: 'object' } }] });
const call = (input, extra = {}) => tool({ toolUseId: 'a', name: 'write', input, ...extra });

function watching(backend, upstream, options = eligible(), body = toolBody()) {
    backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
    const events = [];
    const operation = (async () => {
        try { for await (const event of backend.generateContentStream(model, body, options)) events.push(event); return null; }
        catch (error) { return error; }
    })();
    return { events, operation };
}

async function until(predicate) {
    await bounded((async () => { while (!predicate()) await tick(); })());
}

function expectNonOverlapping(events) {
    let open;
    for (const event of events) {
        if (event.type === 'content_block_start') { expect(open).toBeUndefined(); open = event.index; }
        if (event.type === 'content_block_delta') expect(event.index).toBe(open);
        if (event.type === 'content_block_stop') { expect(event.index).toBe(open); open = undefined; }
    }
    expect(open).toBeUndefined();
}

function emittedToolInputs(events) {
    return starts(events).map(start => JSON.parse(events
        .filter(event => event.index === start.index && event.delta?.type === 'input_json_delta')
        .map(event => event.delta.partial_json).join('')));
}

function expectSuccessfulToolTurn(events, inputs) {
    expect(emittedToolInputs(events)).toEqual(inputs);
    expectNonOverlapping(events);
    expect(events.filter(event => event.type === 'message_start')).toHaveLength(1);
    expect(events.filter(event => event.type === 'message_delta')).toEqual([
        expect.objectContaining({ delta: expect.objectContaining({ stop_reason: 'tool_use' }),
            usage: expect.objectContaining({ input_tokens: 12, output_tokens: expect.any(Number) }) })
    ]);
    expect(events.filter(event => event.type === 'message_stop')).toHaveLength(1);
    expect(events.at(-1).type).toBe('message_stop');
}

describe('opt-in incremental Kiro native tool arguments', () => {
    test('sends the first real fragment while upstream stays open, without waiting for stop or EOF', async () => {
        const upstream = openStream(), backend = configured([]);
        const { events, operation } = watching(backend, upstream);
        try {
            upstream.push(call(''));
            await tick();
            expect(events).toEqual([]);
            upstream.push(tool({ toolUseId: 'a', input: '{"path":' }));
            await until(() => args(events).length === 1);
            expect(args(events)).toEqual(['{"path":']);
            expect(starts(events)[0]).toMatchObject({ index: 0, content_block: { id: 'a', name: 'write' } });
            expect(events.some(event => event.type === 'content_block_stop' || event.type === 'message_stop')).toBe(false);
            upstream.push(tool({ toolUseId: 'a', input: '"x"}' }));
            await until(() => args(events).length === 2);
            expect(args(events)).toEqual(['{"path":', '"x"}']);
            upstream.push(tool({ toolUseId: 'a', stop: true })); upstream.push(null);
            expect(await bounded(operation)).toBeNull();
            expectNonOverlapping(events);
            expect(events.at(-1).type).toBe('message_stop');
        } finally { upstream.destroy(); await operation; }
    });

    test.each(['validated', undefined, 'invalid'])('mode %p preserves full validation and a single parameter delta', async mode => {
        const upstream = openStream(), backend = service([], { KIRO_TOOL_STREAM_MODE: mode });
        const { events, operation } = watching(backend, upstream);
        upstream.push(call('{"path":'));
        await tick(); expect(events).toEqual([]);
        upstream.push(tool({ toolUseId: 'a', input: '"x"}', stop: true })); upstream.push(null);
        expect(await bounded(operation)).toBeNull();
        expect(args(events)).toEqual(['{"path":"x"}']);
    });

    test.each([undefined, false])('missing/false trusted protocol gate %p cannot be forged by request fields', async toolGate => {
        const upstream = openStream(), backend = configured([]);
        const { events, operation } = watching(backend, upstream, { kiroTiming: { toolGate } },
            { ...toolBody(), kiroTiming: { toolGate: true }, kiroToolStreamMode: 'incremental', KIRO_TOOL_STREAM_MODE: 'incremental' });
        upstream.push(call('{"path":'));
        await tick(); expect(events).toEqual([]);
        upstream.push(tool({ toolUseId: 'a', input: '"x"}', stop: true })); upstream.push(null);
        expect(await bounded(operation)).toBeNull();
        expect(args(events)).toEqual(['{"path":"x"}']);
    });

    test('freezes the configured mode when generation begins', async () => {
        const upstream = openStream(), backend = configured([]);
        const { events, operation } = watching(backend, upstream);
        upstream.push(call('{"path":'));
        await until(() => args(events).length === 1);
        backend.config.KIRO_TOOL_STREAM_MODE = 'validated';
        upstream.push(tool({ toolUseId: 'a', input: '"x"}' }));
        await until(() => args(events).length === 2);
        upstream.push(tool({ toolUseId: 'a', stop: true })); upstream.push(null);
        expect(await bounded(operation)).toBeNull();
    });

    test('a compatible complete snapshot sends only the remaining suffix', async () => {
        const events = await collect(configured([call('{"path":'), tool({ toolUseId: 'a', input: { path: 'x' }, stop: true })])
            .generateContentStream(model, toolBody(), eligible()));
        expect(args(events)).toEqual(['{"path":', '"x"}']);
    });

    test('a conflicting snapshot fails explicitly after a prefix, with no normal tool or message completion', async () => {
        const upstream = openStream(), backend = configured([]);
        const { events, operation } = watching(backend, upstream);
        upstream.push(call('{ "path":'));
        await until(() => args(events).length === 1);
        upstream.push(tool({ toolUseId: 'a', input: { path: 'x' }, stop: true })); upstream.push(null);
        const error = await bounded(operation);
        expect(error).toMatchObject({ code: 'KIRO_STREAM_INTEGRITY', kiroIncrementalToolFailure: true });
        expect(error.message).toMatch(/snapshot conflicts/);
        expect(events.some(event => event.type === 'content_block_stop' || event.type === 'message_stop')).toBe(false);
        expect(backend._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
        expect(upstream.destroyed).toBe(true);
    });

    test.each(['incremental', 'validated'])('empty-object stop preserves existing arguments in %s', async mode => {
        const events = await collect(service([call('{"path":"x"}'), tool({ toolUseId: 'a', input: {}, stop: true })],
            { KIRO_TOOL_STREAM_MODE: mode }).generateContentStream(model, toolBody(), eligible()));
        expect(args(events).join('')).toBe('{"path":"x"}');
    });

    test('explicit argument-free stop emits a valid empty object', async () => {
        const events = await collect(configured([call({}, { stop: true })]).generateContentStream(model, toolBody(), eligible()));
        expect(args(events)).toEqual(['{}']); expectNonOverlapping(events);
    });

    test('ID-late calls hold their prefix until the real identity arrives', async () => {
        const upstream = openStream(), backend = configured([]);
        const { events, operation } = watching(backend, upstream);
        upstream.push(tool({ name: 'write', input: '{"path":' }));
        await tick(); expect(events).toEqual([]);
        upstream.push(tool({ toolUseId: 'real', input: '"x"}' }));
        await until(() => args(events).length === 1);
        expect(starts(events)[0].content_block.id).toBe('real');
        expect(args(events)).toEqual(['{"path":"x"}']);
        upstream.push(tool({ toolUseId: 'real', stop: true })); upstream.push(null);
        expect(await bounded(operation)).toBeNull();
    });

    test('a call that never receives a real ID uses validated completion', async () => {
        const upstream = openStream(), backend = configured([]);
        const { events, operation } = watching(backend, upstream);
        upstream.push(tool({ name: 'write', input: '{"path":"x"}' }));
        await tick(); expect(events).toEqual([]);
        upstream.push(tool({ input: {}, stop: true })); upstream.push(null);
        expect(await bounded(operation)).toBeNull();
        expect(starts(events)[0].content_block.id).toMatch(/^tool_/);
        expect(args(events)).toEqual(['{"path":"x"}']);
    });

    test('interleaved calls, text and reasoning stay ordered and never overlap', async () => {
        const backend = configured([
            call('{"a":'), tool({ toolUseId: 'b', name: 'write', input: '{"b":' }),
            text('queued text'), frame('reasoningContentEvent', { text: 'queued reasoning' }),
            tool({ toolUseId: 'b', input: '2}', stop: true }), tool({ toolUseId: 'a', input: '1}', stop: true })
        ]);
        const events = await collect(backend.generateContentStream(model, toolBody(), eligible()));
        expect(starts(events).map(event => event.content_block.id)).toEqual(['a', 'b']);
        expect(args(events)).toEqual(['{"a":', '1}', '{"b":2}']);
        const kinds = events.filter(event => event.type === 'content_block_start').map(event => event.content_block.type);
        expect(kinds).toEqual(['tool_use', 'tool_use', 'text', 'thinking']);
        expectNonOverlapping(events);
    });

    test('an unsent queued call still accepts an arbitrary object replacement', async () => {
        const events = await collect(configured([
            call('{"a":'), tool({ toolUseId: 'b', name: 'write', input: '{ "path":' }),
            tool({ toolUseId: 'b', input: { path: 'x' }, stop: true }), tool({ toolUseId: 'a', input: '1}', stop: true })
        ]).generateContentStream(model, toolBody(), eligible()));
        expect(args(events)).toEqual(['{"a":', '1}', '{"path":"x"}']);
    });

    test('a late larger real ID remains inside the pending metadata budget', async () => {
        const backend = configured([
            tool({ name: 'write', input: '{"path":' }),
            tool({ toolUseId: 'x'.repeat(300), input: '"x"}', stop: true })
        ]);
        backend.config.KIRO_MAX_TOOL_STREAM_QUEUE_BYTES = 256;
        await expect(collect(backend.generateContentStream(model, toolBody(), eligible())))
            .rejects.toMatchObject({ code: 'KIRO_STREAM_INTEGRITY', message: expect.stringContaining('queue limit') });
    });

    test('a failure identifies the unsent queued call rather than an earlier emitted call', async () => {
        const upstream = openStream(), backend = configured([]);
        const { events, operation } = watching(backend, upstream);
        upstream.push(call('{"a":'));
        await until(() => args(events).length === 1);
        upstream.push(tool({ toolUseId: 'b', name: 'write', input: '{"b":' }));
        upstream.push(tool({ toolUseId: 'b', input: 'bad', stop: true })); upstream.push(null);
        expect(await bounded(operation)).toMatchObject({ code: 'KIRO_STREAM_INTEGRITY', kiroToolCallId: 'b' });
        expect(starts(events).map(event => event.content_block.id)).toEqual(['a']);
    });

    test.each(['malformed', 'empty', 'array', 'trailing frame', 'arguments limit', 'queue bytes', 'queue events', 'call count'])('%s failure does not fabricate success', async kind => {
        const upstream = openStream(), backend = configured([]);
        if (kind === 'arguments limit') backend.config.KIRO_MAX_TOOL_ARGUMENT_BYTES = 8;
        if (kind === 'queue bytes') backend.config.KIRO_MAX_TOOL_STREAM_QUEUE_BYTES = 256;
        if (kind === 'queue events') backend.config.KIRO_MAX_TOOL_STREAM_QUEUE_EVENTS = 1;
        if (kind === 'call count') backend.config.KIRO_MAX_TOOL_CALLS = 1;
        const { events, operation } = watching(backend, upstream);
        upstream.push(call(kind === 'empty' ? '' : kind === 'array' ? '[' : '{"a":'));
        if (!['empty'].includes(kind)) await until(() => args(events).length === 1);
        if (kind === 'malformed') upstream.push(tool({ toolUseId: 'a', input: 'bad', stop: true }));
        if (kind === 'array') upstream.push(tool({ toolUseId: 'a', input: ']', stop: true }));
        if (kind === 'trailing frame') upstream.push(text('lost').subarray(0, -2));
        if (kind === 'arguments limit') upstream.push(tool({ toolUseId: 'a', input: 'x'.repeat(20) }));
        if (kind === 'queue bytes') upstream.push(text('x'.repeat(300)));
        if (kind === 'queue events' || kind === 'call count') upstream.push(tool({ toolUseId: 'b', name: 'write', input: '{' }));
        upstream.push(null);
        expect(await bounded(operation)).toMatchObject({ code: 'KIRO_STREAM_INTEGRITY', kiroIncrementalToolFailure: true });
        expect(events.some(event => event.type === 'content_block_stop' || event.type === 'message_stop')).toBe(false);
    });

    test('valid unfinished JSON completes at normal EOF and counts split surrogate pairs correctly', async () => {
        const input = '{"path":"中文😀"}', split = input.indexOf('😀') + 1;
        const backend = configured([call(input.slice(0, split)), tool({ toolUseId: 'a', input: input.slice(split) })]);
        backend.config.KIRO_MAX_TOOL_ARGUMENT_BYTES = Buffer.byteLength(input);
        const events = await collect(backend.generateContentStream(model, toolBody(), eligible()));
        expect(args(events).join('')).toBe(input); expectNonOverlapping(events);
    });

    test('cancellation after a fragment closes upstream without a normal tool completion', async () => {
        const upstream = openStream(), backend = configured([]), controller = new AbortController();
        const { events, operation } = watching(backend, upstream, { ...eligible(), signal: controller.signal });
        upstream.push(call('{"path":'));
        await until(() => args(events).length === 1);
        controller.abort();
        expect(await bounded(operation)).toMatchObject({ name: expect.stringMatching(/Error/) });
        expect(upstream.destroyed).toBe(true);
        expect(events.some(event => event.type === 'content_block_stop' || event.type === 'message_stop')).toBe(false);
    });

    test('an internally consumed partial tool uses neutral recovery advice without claiming a client write', async () => {
        const upstream = openStream(), backend = configured([]);
        const { events, operation } = watching(backend, upstream);
        upstream.push(call('{"path":'));
        await until(() => args(events).length === 1);
        upstream.push(tool({ toolUseId: 'a', input: 'bad', stop: true })); upstream.push(null);
        const error = await bounded(operation);
        expect(error.recoveryHint).toContain('do not execute or repair');
        expect(error.message).not.toContain('No malformed tool call was emitted.');
        expect(error.message).not.toContain('Partial tool data was already sent.');
    });

    test('the placeholder tool cannot emit a start or arguments', async () => {
        const events = await collect(configured([
            tool({ toolUseId: 'ignored', name: 'no_tool_available', input: '{"a":' }),
            tool({ toolUseId: 'ignored', input: '1}', stop: true }), text('real content')
        ]).generateContentStream(model, toolBody(), eligible()));
        expect(starts(events)).toEqual([]); expect(args(events)).toEqual([]);
    });

    test('legacy after native deduplicates; equal independent native IDs remain independent', async () => {
        const events = await collect(configured([
            call('{"path":'), text('[Called write with args: {"path":"x"}]'),
            tool({ toolUseId: 'a', input: '"x"}', stop: true }),
            tool({ toolUseId: 'b', name: 'write', input: { path: 'x' }, stop: true })
        ]).generateContentStream(model, toolBody(), eligible()));
        expect(starts(events).map(event => event.content_block.id)).toEqual(['a', 'b']);
        expect(args(events).join('')).toBe('{"path":"x"}{"path":"x"}'); expectNonOverlapping(events);
    });

    test('legacy-first responses retain validated native deduplication', async () => {
        const events = await collect(configured([
            text('[Called write with args: {"path":"x"}]'), call('{ "path":'),
            tool({ toolUseId: 'a', input: { path: 'x' }, stop: true }),
            tool({ toolUseId: 'b', name: 'write', input: { path: 'y' }, stop: true })
        ]).generateContentStream(model, toolBody(), eligible()));
        expect(starts(events)).toHaveLength(2);
        expect(args(events)).toEqual(['{"path":"x"}', '{"path":"y"}']); expectNonOverlapping(events);
    });

    test('a buffered legacy call deduplicates an already complete native representation', async () => {
        const events = await collect(configured([
            text('[Called write with args: {"path":"x"}]\\'),
            call({ path: 'x' }, { stop: true })
        ]).generateContentStream(model, toolBody(), eligible()));
        expectSuccessfulToolTurn(events, [{ path: 'x' }]);
    });

    test.each(['stop', 'EOF'])('a buffered legacy call survives a distinct native call completed by %s', async completion => {
        const events = await collect(configured([
            text('[Called write with args: {"path":"legacy"}]\\'),
            call('{"path":'),
            tool({ toolUseId: 'a', input: '"native"}', ...(completion === 'stop' ? { stop: true } : {}) })
        ]).generateContentStream(model, toolBody(), eligible()));
        expectSuccessfulToolTurn(events, [{ path: 'legacy' }, { path: 'native' }]);
    });

    test('buffered legacy calls stay ahead of distinct interleaved native calls', async () => {
        const events = await collect(configured([
            text('[Called write with args: {"path":"legacy-1"}][Called write with args: {"path":"legacy-2"}]\\'),
            call('{"path":'),
            tool({ toolUseId: 'b', name: 'write', input: { path: 'native-2' }, stop: true }),
            tool({ toolUseId: 'a', input: '"native-1"}', stop: true })
        ]).generateContentStream(model, toolBody(), eligible()));
        expectSuccessfulToolTurn(events, [
            { path: 'legacy-1' }, { path: 'legacy-2' }, { path: 'native-1' }, { path: 'native-2' }
        ]);
    });

    test('queued legacy text cannot emit later native calls before their queue positions', async () => {
        const upstream = openStream(), backend = configured([]);
        const { events, operation } = watching(backend, upstream);
        try {
            upstream.push(call('{"path":'));
            await until(() => args(events).length === 1);
            upstream.push(text('[Called write with args: {"path":"legacy"}]'));
            upstream.push(tool({ toolUseId: 'b', name: 'write', input: '{"path":' }));
            upstream.push(tool({ toolUseId: 'c', name: 'write', input: '{"path":' }));
            upstream.push(tool({ toolUseId: 'a', input: '"native-1"}', stop: true }));
            await until(() => starts(events).length === 2);
            expect(emittedToolInputs(events)).toEqual([{ path: 'native-1' }, { path: 'legacy' }]);
            upstream.push(tool({ toolUseId: 'c', input: '"native-3"}', stop: true }));
            await tick();
            expect(starts(events)).toHaveLength(2);
            upstream.push(tool({ toolUseId: 'b', input: '"native-2"}', stop: true }));
            upstream.push(null);
            expect(await bounded(operation)).toBeNull();
            expectSuccessfulToolTurn(events, [
                { path: 'native-1' }, { path: 'legacy' }, { path: 'native-2' }, { path: 'native-3' }
            ]);
        } finally { upstream.destroy(); await operation; }
    });

    test('a tool boundary preserves an unresolved separator after inline thinking', async () => {
        const events = await collect(configured([
            text('<thinking>reason</thinking>\n'),
            call('{"path":'), tool({ toolUseId: 'a', input: '"x"}', stop: true })
        ]).generateContentStream(model, { ...toolBody(), thinking: { type: 'enabled', budget_tokens: 1024 } }, eligible()));
        expectSuccessfulToolTurn(events, [{ path: 'x' }]);
        const visibleText = events.filter(event => event.delta?.type === 'text_delta');
        expect(visibleText.map(event => event.delta.text).join('')).toBe('\n');
        expect(events.indexOf(visibleText[0])).toBeLessThan(events.indexOf(starts(events)[0]));
        expect(events.filter(event => event.delta?.type === 'thinking_delta').map(event => event.delta.thinking).join('')).toBe('reason');
    });

    test('a validated fallback flushes an escape lookahead before its tool block', async () => {
        const events = await collect(configured([
            text('before\\'), tool({ name: 'write', input: '{"path":"x"}', stop: true })
        ]).generateContentStream(model, toolBody(), eligible()));
        const ordered = events.filter(event => event.delta?.text || event.content_block?.type === 'tool_use');
        expect(ordered[0].delta.text).toBe('before\\');
        expect(ordered[1].content_block.type).toBe('tool_use');
        expectNonOverlapping(events);
    });
});

describe('Kiro tool mode entry isolation', () => {
    const replacingFrames = () => [call('{ "path":'), tool({ toolUseId: 'a', input: { path: 'x' }, stop: true })];
    test('unary always validates before exposing a complete tool object', async () => {
        const message = await configured(replacingFrames()).generateContent(model, toolBody(), eligible());
        expect(message.content[0]).toMatchObject({ type: 'tool_use', input: { path: 'x' } });
    });
    test('explicit buffered streams preserve arbitrary object replacement and one complete delta', async () => {
        const events = await collect(configured(replacingFrames()).generateContentStreamBuffered(model, toolBody(), eligible()));
        expect(args(events)).toEqual(['{"path":"x"}']);
    });
    test('the adapter respects buffered selection despite incremental account config', async () => {
        const adapter = Object.create(KiroApiServiceAdapter.prototype);
        adapter.kiroApiService = configured(replacingFrames()); adapter.kiroApiService.config.KIRO_CC_BUFFERED = true;
        const events = await collect(adapter.generateContentStream(model, { ...toolBody(), _ccEndpoint: true }, eligible()));
        expect(args(events)).toEqual(['{"path":"x"}']);
    });
    test.each([undefined, false])('unsupported or missing protocol gate %p cannot expose malformed tools', async gate => {
        const upstream = openStream(), backend = configured([]);
        const { events, operation } = watching(backend, upstream, { kiroTiming: { toolGate: gate } });
        upstream.push(call('{"path":')); await tick(); expect(events).toEqual([]);
        upstream.push(tool({ toolUseId: 'a', input: 'bad', stop: true })); upstream.push(null);
        expect(await bounded(operation)).toMatchObject({ code: 'KIRO_STREAM_INTEGRITY' }); expect(starts(events)).toEqual([]);
    });
    test('a direct internal mode option cannot bypass the trusted gate or unary mode', () => {
        expect(resolveKiroToolStreamMode({ KIRO_TOOL_STREAM_MODE: 'incremental' }, { kiroToolStreamMode: 'incremental' })).toBe('validated');
        expect(resolveKiroToolStreamMode({ KIRO_TOOL_STREAM_MODE: 'incremental' }, { ...eligible(), kiroOutputMode: 'unary' })).toBe('validated');
    });
});
