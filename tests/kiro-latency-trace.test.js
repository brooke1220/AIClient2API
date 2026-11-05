import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import logger from '../src/utils/logger.js';
import '../src/converters/register-converters.js';
import { KiroApiServiceAdapter } from '../src/providers/adapter.js';
import { KiroToolAssembler } from '../src/providers/claude/kiro-tool-assembler.js';
import { createKiroRequestTrace } from '../src/providers/claude/kiro-request-trace.js';
import { handleStreamRequest } from '../src/utils/common.js';
import * as services from '../src/services/service-manager.js';
import { frame, text, request, model, service, collect, openStream, tick } from './helpers/kiro-safety-fixtures.js';

const SECRET_ID = 'tooluse_secret_id';
const SECRET_ARG = 'secret-arg-value';
const reasoning = value => frame('reasoningContentEvent', { text: value });
const toolFrames = () => [
    frame('toolUseEvent', { toolUseId: SECRET_ID, name: 'record_probe', input: '' }),
    frame('toolUseEvent', { toolUseId: SECRET_ID, input: `{"path":"${SECRET_ARG}"` }),
    frame('toolUseEvent', { toolUseId: SECRET_ID, input: '}', stop: true })
];
const logs = prefix => logger.info.mock.calls.flat()
    .filter(value => typeof value === 'string' && value.startsWith(`${prefix} `));
const records = prefix => logs(prefix).map(value => JSON.parse(value.slice(prefix.length + 1)));
const allTraceLogs = () => [...logs('[Kiro Trace]'), ...logs('[Kiro Tool Trace]'), ...logs('[Kiro Downstream]')].join('\n');

describe('Kiro tool assembler opt-in timing', () => {
    test('without a clock nothing extra is recorded or emitted', () => {
        const assembler = new KiroToolAssembler();
        const [call] = assembler.feed({ toolUseId: 'a', name: 'x', input: '{}', stop: true });
        expect(assembler.stats).toBeNull();
        expect(assembler.traceFor('a')).toBeUndefined();
        expect(call).not.toHaveProperty('trace');
    });

    test('an empty-object placeholder keeps the arguments and is counted apart from snapshots', () => {
        let now = 0;
        const assembler = new KiroToolAssembler(undefined, undefined, () => ++now);
        assembler.feed({ toolUseId: 'a', name: 'x' });
        assembler.feed({ toolUseId: 'a', input: '{"path":"x"}' });
        assembler.feed({ toolUseId: 'a', input: { path: 'x' } });
        const [call] = assembler.feed({ toolUseId: 'a', input: {}, stop: true });
        expect(call.arguments).toBe('{"path":"x"}');
        expect(call).not.toHaveProperty('trace');
        expect(assembler.stats).toEqual({ objectAfterString: 1, prefixMatch: 1, emptyObjects: 1 });
        expect(assembler.traceFor('a')).toMatchObject({ callKey: 1, native: true, identityMs: 1, firstArgsMs: 2,
            identityReadyAtArgs: true, priorOpenAtArgs: false, validatedMs: 3 });
    });

    test('a re-serialized object that differs from the sent prefix is a snapshot without a prefix match', () => {
        const assembler = new KiroToolAssembler(undefined, undefined, () => 0);
        assembler.feed({ toolUseId: 'a', name: 'x', input: '{ "path": "x"' });
        assembler.feed({ toolUseId: 'a', input: { path: 'x' }, stop: true });
        expect(assembler.stats).toEqual({ objectAfterString: 1, prefixMatch: 0, emptyObjects: 0 });
    });

    test('blocking by an earlier open call and a late real ID are recorded per call', () => {
        const assembler = new KiroToolAssembler(undefined, undefined, () => 0);
        assembler.feed({ toolUseId: 'a', name: 'x' });
        assembler.feed({ toolUseId: 'b', name: 'y', input: '{"k":1}', stop: true });
        expect(assembler.traceFor('b')).toMatchObject({ callKey: 2, priorOpenAtArgs: true });
        expect(assembler.feed({ toolUseId: 'a', input: '{"k":2}', stop: true }).map(call => call.toolUseId)).toEqual(['a', 'b']);

        const late = new KiroToolAssembler(undefined, undefined, () => 0);
        late.feed({ name: 'z', input: '{"k":' });
        late.feed({ toolUseId: 'real', input: '1}', stop: true });
        expect(late.traceFor('real')).toMatchObject({ callKey: 1, identityReadyAtArgs: false });
        expect(Number.isFinite(late.traceFor('real').identityMs)).toBe(true);
    });
});

describe('Kiro upstream trace classification', () => {
    beforeEach(() => logger.info.mockClear());
    afterEach(() => jest.restoreAllMocks());

    test('a name-only start is not a parameter, and id-less placeholder fragments are ignored', () => {
        let now = 0;
        jest.spyOn(performance, 'now').mockImplementation(() => now);
        const trace = createKiroRequestTrace({ config: { KIRO_REQUEST_TRACE: true } }, model,
            { kiroTiming: { startedAt: 0 } }, 'no_tool_available');
        now = 10; trace.accept({ type: 'toolUse', data: { name: 'no_tool_available', input: '{"a":1}' } });
        now = 20; trace.accept({ type: 'toolUseInput', data: { input: '{"b":2}' } });
        now = 30; trace.accept({ type: 'toolUseStop', data: { stop: true } });
        now = 40; trace.accept({ type: 'toolUse', data: { toolUseId: 'real', name: 'record_probe', input: '' } });
        now = 50; trace.accept({ type: 'toolUseInput', data: { toolUseId: 'real', input: '{"c":' } });
        trace.finish(null, true);
        expect(records('[Kiro Trace]')[0]).toMatchObject({ firstToolMs: 40, firstToolArgsMs: 50 });
    });

    test('whitespace before real parameters does not start upstream argument timing', () => {
        let now = 0;
        jest.spyOn(performance, 'now').mockImplementation(() => now);
        const trace = createKiroRequestTrace({ config: { KIRO_REQUEST_TRACE: true } }, model,
            { kiroTiming: { startedAt: 0 } }, 'no_tool_available');
        now = 10;
        trace.accept({ type: 'toolUse', data: { toolUseId: 'real', name: 'record_probe', input: '\n  ' } });
        now = 1000;
        trace.accept({ type: 'toolUseInput', data: { toolUseId: 'real', input: '{"path":"x"}', stop: true } });
        trace.finish(null, true);
        expect(records('[Kiro Trace]')[0]).toMatchObject({ firstToolMs: 10, firstToolArgsMs: 1000 });
    });

    test('classified first-event times and per-call tool timing are logged without IDs or arguments', async () => {
        const backend = service([reasoning('plan'), text('answer'), ...toolFrames()], { KIRO_REQUEST_TRACE: true });
        await collect(backend.generateContentStream(model, request()));
        const [trace] = records('[Kiro Trace]');
        for (const field of ['headersMs', 'firstReasoningMs', 'firstContentMs', 'firstToolMs', 'firstToolArgsMs']) {
            expect(Number.isFinite(trace[field])).toBe(true);
        }
        expect(trace.firstToolArgsMs).toBeGreaterThanOrEqual(trace.firstToolMs);
        const [tools] = records('[Kiro Tool Trace]');
        expect(tools).toMatchObject({ requestId: trace.requestId, attempt: 1, mode: 'stream', toolGate: false, callCount: 1,
            snapshots: { objectAfterString: 0, prefixMatch: 0, emptyObjects: 0 } });
        expect(tools.calls[0]).toMatchObject({ callKey: 1, native: true, done: true, identityReadyAtArgs: true,
            priorOpenAtArgs: false, gateSample: false });
        expect(tools.calls[0].validatedMs).toBeGreaterThanOrEqual(tools.calls[0].firstArgsMs);
        expect(allTraceLogs()).not.toMatch(new RegExp(`${SECRET_ID}|${SECRET_ARG}|answer|plan`));
    });

    test('the placeholder tool is not counted as a tool start or parameter', async () => {
        const backend = service([frame('toolUseEvent', { toolUseId: 'ph', name: 'no_tool_available', input: '{"a":1}' }),
            frame('toolUseEvent', { toolUseId: 'ph', input: '{}', stop: true }), text('answer')], { KIRO_REQUEST_TRACE: true });
        await collect(backend.generateContentStream(model, request()));
        const [trace] = records('[Kiro Trace]');
        expect(trace).not.toHaveProperty('firstToolMs');
        expect(trace).not.toHaveProperty('firstToolArgsMs');
        expect(Number.isFinite(trace.firstContentMs)).toBe(true);
        expect(logs('[Kiro Tool Trace]')).toHaveLength(0);
    });

    test('tracing stays off by default: no trace logs, trace ID or tool timing map', async () => {
        const kiroTiming = { startedAt: 0 };
        const backend = service([text('answer'), ...toolFrames()]);
        await collect(backend.generateContentStream(model, request(), { kiroTiming }));
        expect(allTraceLogs()).toBe('');
        expect(kiroTiming).not.toHaveProperty('traceId');
        expect(kiroTiming).not.toHaveProperty('toolTraces');
    });
});

describe('Kiro downstream timing summary', () => {
    beforeEach(() => logger.info.mockClear());
    afterEach(() => jest.restoreAllMocks());

    const responseMock = () => {
        const res = new EventEmitter();
        res.writableEnded = false;
        res.writeHead = jest.fn(() => { res.headersSent = true; });
        res.flushHeaders = jest.fn();
        res.write = jest.fn(() => true);
        res.end = jest.fn(() => { res.writableEnded = true; });
        return res;
    };
    const adapterFor = backend => Object.assign(Object.create(KiroApiServiceAdapter.prototype), { kiroApiService: backend });
    const run = (backend, res, client, extra = {}, body = request()) => handleStreamRequest(res, adapterFor(backend), model, body, client,
        'claude-kiro-oauth', 'none', null, null, null, null, {
            maxRetries: 0, ...extra,
            CONFIG: { SSE_HEARTBEAT_INTERVAL_MS: 0, EMPTY_RESPONSE_MAX_RETRIES: 0, ...extra.CONFIG }
        });

    test('an upstream failure after text was written is an error, not a completed request', async () => {
        const backend = service([text('answer'), frame('toolUseEvent', {
            toolUseId: SECRET_ID, name: 'record_probe', input: '{', stop: true
        })], { KIRO_REQUEST_TRACE: true });
        const res = responseMock();
        await run(backend, res, 'claude');
        expect(res.write.mock.calls.some(([record]) => record.startsWith('event: error\n'))).toBe(true);
        expect(records('[Kiro Downstream]')).toEqual([expect.objectContaining({ attempts: 1, outcome: 'error' })]);
    });

    test('an empty response with an exhausted retry budget is an error', async () => {
        const res = responseMock();
        await run(service([], { KIRO_REQUEST_TRACE: true }), res, 'claude');
        expect(res.write.mock.calls.some(([record]) => record.startsWith('event: error\n'))).toBe(true);
        expect(records('[Kiro Downstream]')).toEqual([expect.objectContaining({ attempts: 1, outcome: 'error' })]);
    });

    test.each([true, false])('an empty-response retry that succeeds=%s records the final request outcome once', async succeeds => {
        const retryBackend = service(succeeds ? [text('answer')] : [], { KIRO_REQUEST_TRACE: true });
        const select = jest.spyOn(services, 'getApiServiceWithFallback').mockResolvedValue({
            service: adapterFor(retryBackend), actualProviderType: 'claude-kiro-oauth'
        });
        await run(service([], { KIRO_REQUEST_TRACE: true }), responseMock(), 'claude', {
            CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1, EMPTY_RESPONSE_RETRY_DELAY_MS: 0 }
        });
        expect(select).toHaveBeenCalledTimes(1);
        expect(records('[Kiro Downstream]')).toEqual([expect.objectContaining({
            attempts: 2, outcome: succeeds ? 'completed' : 'error'
        })]);
    });

    test('a successful retry through another provider clears the earlier Kiro failure', async () => {
        const select = jest.spyOn(services, 'getApiServiceWithFallback').mockResolvedValue({
            actualProviderType: 'openai-custom',
            service: { generateContentStream: async function* () {
                yield { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] };
            } }
        });
        await run(service([], { KIRO_REQUEST_TRACE: true }), responseMock(), 'claude', {
            CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1, EMPTY_RESPONSE_RETRY_DELAY_MS: 0 }
        });
        expect(select).toHaveBeenCalledTimes(1);
        expect(records('[Kiro Downstream]')).toEqual([expect.objectContaining({ outcome: 'completed' })]);
    });

    test.each(['claude', 'openai', 'openaiResponses'])('%s client gets classified write times paired with the same call', async client => {
        const backend = service([reasoning('plan'), text('answer'), ...toolFrames()], { KIRO_REQUEST_TRACE: true });
        await run(backend, responseMock(), client);
        const [summary] = records('[Kiro Downstream]');
        expect(summary).toMatchObject({ attempts: 1, mode: 'stream', protocol: client, outcome: 'completed' });
        for (const field of ['firstReasoningMs', 'firstTextMs', 'firstToolArgsMs', 'endMs']) {
            expect(Number.isFinite(summary[field])).toBe(true);
        }
        expect(summary.events).toBeGreaterThan(0);
        expect(summary.bytes).toBeGreaterThan(0);
        const [tools] = records('[Kiro Tool Trace]');
        expect(tools).toMatchObject({ requestId: summary.requestId, toolGate: true });
        const [call] = tools.calls;
        expect(call.firstWriteMs).toBeGreaterThanOrEqual(call.firstArgsMs);
        expect(call.waitMs).toBe(call.firstWriteMs - call.firstArgsMs);
        expect(call).toMatchObject({ backpressure: false, gateSample: true });
        expect(allTraceLogs()).not.toMatch(new RegExp(`${SECRET_ID}|${SECRET_ARG}`));
    });

    test('a drain wait after the call\'s arguments arrived excludes it from the gate sample', async () => {
        const backend = service([text('answer'), ...toolFrames()], { KIRO_REQUEST_TRACE: true });
        const res = responseMock();
        res.write.mockImplementation(record => {
            if (!record.includes('"type":"tool_use"')) return true;
            res.writableNeedDrain = true;
            setImmediate(() => { res.writableNeedDrain = false; res.emit('drain'); });
            return false;
        });
        await run(backend, res, 'claude');
        const [call] = records('[Kiro Tool Trace]')[0].calls;
        expect(call).toMatchObject({ backpressure: true, gateSample: false });
        expect(records('[Kiro Downstream]')[0].drainWaits).toBe(1);
        expect(res.listenerCount('drain')).toBe(0);
    });

    test.each([
        ...['claude', 'openai', 'openaiResponses'].flatMap(client =>
            [true, false].map(overlaps => [client, overlaps, true])),
        ['claude', true, false]
    ])('%s prior heartbeat drain overlaps arguments=%s, trace ready=%s', async (client, overlaps, traceReady) => {
        jest.useFakeTimers({ doNotFake: ['performance', 'setImmediate', 'nextTick'] });
        let now = 0;
        jest.spyOn(performance, 'now').mockImplementation(() => now);
        const upstream = openStream();
        const backend = service([], { KIRO_REQUEST_TRACE: true });
        backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
        let resumePreparation;
        if (!traceReady) backend._prepareAccessTokenForRequest.mockReturnValue(
            new Promise(resolve => { resumePreparation = resolve; }));
        const kiroTiming = { startedAt: 0 };
        const res = responseMock();
        res.write.mockImplementation(record => {
            if (record !== ': keep-alive\n\n') return true;
            res.writableNeedDrain = true;
            return false;
        });
        const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
        const drainAt = async at => {
            now = at;
            res.writableNeedDrain = false;
            res.emit('drain');
            await settle();
        };
        const pending = run(backend, res, client, { kiroTiming, CONFIG: { SSE_HEARTBEAT_INTERVAL_MS: 10 } });
        try {
            await settle();
            if (!traceReady) expect(kiroTiming).not.toHaveProperty('traceId');
            now = 100;
            await jest.advanceTimersByTimeAsync(10);
            expect(res.write).toHaveBeenCalledWith(': keep-alive\n\n');
            if (!traceReady) {
                resumePreparation();
                await settle();
                expect(kiroTiming.traceId).toBeDefined();
            }
            if (!overlaps) await drainAt(150);

            now = 200;
            upstream.push(frame('toolUseEvent', {
                toolUseId: SECRET_ID, name: 'record_probe', input: `{"path":"${SECRET_ARG}"}`, stop: true
            }));
            await settle();
            if (overlaps) {
                expect(res.write.mock.calls.some(([record]) => record.includes(SECRET_ARG))).toBe(false);
                await drainAt(1200);
            }
            upstream.push(null);
            await pending;

            const [call] = records('[Kiro Tool Trace]')[0].calls;
            expect(call).toMatchObject({ firstArgsMs: 200, validatedMs: 200,
                firstWriteMs: overlaps ? 1200 : 200, waitMs: overlaps ? 1000 : 0,
                backpressure: overlaps, gateSample: !overlaps });
            expect(records('[Kiro Downstream]')[0]).toMatchObject({ drainWaits: 1, outcome: 'completed' });
            expect(res.listenerCount('drain')).toBe(0);
        } finally {
            if (!res.writableEnded) res.emit('close');
            upstream.destroy();
            await pending;
            jest.useRealTimers();
        }
    });

    test.each(['claude', 'openai', 'openaiResponses'])('%s first argument write returning false does not exclude the call from the gate sample', async client => {
        const backend = service(toolFrames(), { KIRO_REQUEST_TRACE: true });
        const res = responseMock();
        let blocked = false;
        res.write.mockImplementation(record => {
            if (blocked || !record.includes(SECRET_ARG)) return true;
            blocked = true;
            res.writableNeedDrain = true;
            setImmediate(() => { res.writableNeedDrain = false; res.emit('drain'); });
            return false;
        });
        await run(backend, res, client);
        const [call] = records('[Kiro Tool Trace]')[0].calls;
        // The call's own record exceeding the highWaterMark is not prior backpressure.
        expect(call).toMatchObject({ backpressure: false, gateSample: true });
        expect(Number.isFinite(call.firstWriteMs)).toBe(true);
        expect(records('[Kiro Downstream]')[0]).toMatchObject({ drainWaits: 1, outcome: 'completed' });
        expect(res.listenerCount('drain')).toBe(0);
    });

    test.each(['claude', 'openai', 'openaiResponses'])('%s native call after an emitted legacy tool is excluded from the gate sample', async client => {
        const backend = service([text('[Called record_probe with args: {"path":"legacy"}]'), ...toolFrames()],
            { KIRO_REQUEST_TRACE: true });
        await run(backend, responseMock(), client, {}, {
            ...request(), tools: [{ name: 'record_probe', input_schema: { type: 'object' } }]
        });
        const [legacy, native] = records('[Kiro Tool Trace]')[0].calls;
        expect(legacy).toMatchObject({ native: false });
        expect(Number.isFinite(legacy.firstWriteMs)).toBe(true);
        expect(native).toMatchObject({ native: true, priorOpenAtArgs: false,
            priorLegacyEmitted: true, backpressure: false, gateSample: false });
        expect(native.firstWriteMs).toBeGreaterThanOrEqual(legacy.firstWriteMs);
    });

    test('a parsed legacy duplicate that was never emitted does not exclude the earlier native call', async () => {
        const [start, ...args] = toolFrames();
        const backend = service([start, text(`[Called record_probe with args: {"path":"${SECRET_ARG}"}]`), ...args],
            { KIRO_REQUEST_TRACE: true });
        await run(backend, responseMock(), 'claude', {}, {
            ...request(), tools: [{ name: 'record_probe', input_schema: { type: 'object' } }]
        });
        const [native, legacy] = records('[Kiro Tool Trace]')[0].calls;
        expect(native).toMatchObject({ native: true, priorLegacyEmitted: false, gateSample: true });
        expect(legacy).toMatchObject({ native: false });
        expect(legacy).not.toHaveProperty('firstWriteMs');
    });

    test('arguments arriving out of order are paired with their own call', async () => {
        let now = 0;
        jest.spyOn(performance, 'now').mockImplementation(() => now);
        const upstream = openStream();
        const backend = service([], { KIRO_REQUEST_TRACE: true });
        backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
        const res = responseMock();
        res.write.mockImplementation(() => { now++; return true; });
        const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
        const push = async (at, data) => { now = at; upstream.push(frame('toolUseEvent', data)); await settle(); };
        const pending = run(backend, res, 'claude');
        await settle();
        await push(150, { toolUseId: 'a', name: 'record_probe', input: '' });
        await push(200, { toolUseId: 'b', name: 'record_probe', input: '{"k":1}', stop: true });
        await push(300, { toolUseId: 'a', input: '{"k":2}' });
        await push(400, { toolUseId: 'a', input: '', stop: true });
        upstream.push(null);
        await pending;
        const [a, b] = records('[Kiro Tool Trace]')[0].calls;
        expect(a).toMatchObject({ callKey: 1, firstArgsMs: 300, validatedMs: 400, priorOpenAtArgs: false, gateSample: true });
        expect(b).toMatchObject({ callKey: 2, firstArgsMs: 200, validatedMs: 200, priorOpenAtArgs: true, gateSample: false });
        expect(a.firstWriteMs).toBeGreaterThan(400);
        expect(b.firstWriteMs).toBeGreaterThan(a.firstWriteMs);
        expect(a.waitMs).toBe(a.firstWriteMs - 300);
    });

    test('buffered and unary output never claim a per-call write time or a gate sample', async () => {
        await run(service(toolFrames(), { KIRO_REQUEST_TRACE: true }), responseMock(), 'claude', {},
            { ...request(), _ccBuffered: true });
        await service(toolFrames(), { KIRO_REQUEST_TRACE: true }).generateContent(model, request());
        const traces = records('[Kiro Tool Trace]');
        expect(traces.map(trace => trace.mode)).toEqual(['buffered', 'unary']);
        for (const trace of traces) {
            expect(trace.calls[0]).not.toHaveProperty('firstWriteMs');
            expect(trace.calls[0].gateSample).toBe(false);
        }
    });

    test.each(['claude', 'openai', 'openaiResponses'])('%s wire output is identical with tracing on and off', async client => {
        const wire = async config => {
            const res = responseMock();
            await run(service([reasoning('plan'), text('answer'), ...toolFrames()], config), res, client);
            return res.write.mock.calls.map(([record]) => String(record)
                .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID')
                .replace(/"(created|created_at|completed_at)":\d+/g, '"$1":0')
                .replace(/\b(chatcmpl|resp|msg|rs|fc|item)_[A-Za-z0-9]+/g, '$1_ID')
                .replace(/user-[0-9a-f]{32}/g, 'user-ID'));
        };
        expect(await wire({ KIRO_REQUEST_TRACE: true })).toEqual(await wire({}));
    });

    test('a drain on a write outside model events, such as the final [DONE], is counted', async () => {
        const res = responseMock();
        res.write.mockImplementation(record => {
            if (record !== 'data: [DONE]\n\n') return true;
            res.writableNeedDrain = true;
            setImmediate(() => { res.writableNeedDrain = false; res.emit('drain'); });
            return false;
        });
        await run(service([text('answer')], { KIRO_REQUEST_TRACE: true }), res, 'openai');
        expect(records('[Kiro Downstream]')[0]).toMatchObject({ drainWaits: 1, outcome: 'completed' });
        expect(res.listenerCount('drain')).toBe(0);
    });

    test('a Gemini client is never a gate sample', async () => {
        const backend = service([text('answer'), ...toolFrames()], { KIRO_REQUEST_TRACE: true });
        await run(backend, responseMock(), 'gemini');
        const [tools] = records('[Kiro Tool Trace]');
        expect(tools.toolGate).toBe(false);
        expect(tools.calls[0].gateSample).toBe(false);
    });

    test('no downstream summary is logged when tracing is off', async () => {
        await run(service([text('answer'), ...toolFrames()]), responseMock(), 'claude');
        expect(allTraceLogs()).toBe('');
    });

    test('a no-argument tool call does not set firstToolArgsMs downstream', async () => {
        const backend = service([
            frame('toolUseEvent', { toolUseId: 'noarg', name: 'record_probe', input: '{}', stop: true })
        ], { KIRO_REQUEST_TRACE: true });
        await run(backend, responseMock(), 'claude');
        const [summary] = records('[Kiro Downstream]');
        expect(summary).toMatchObject({ outcome: 'completed' });
        expect(summary).not.toHaveProperty('firstToolArgsMs');
    });

    test('a downstream write timeout is reported as write_timeout, not client_closed', async () => {
        const backend = service([text('answer')], { KIRO_REQUEST_TRACE: true });
        const res = responseMock();
        res.write.mockReturnValue(false); // never drains
        await run(backend, res, 'claude', { CONFIG: { KIRO_DOWNSTREAM_WRITE_TIMEOUT_MS: 20 } });
        expect(records('[Kiro Downstream]')).toEqual([expect.objectContaining({ outcome: 'write_timeout' })]);
    });
});
