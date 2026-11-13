import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
import '../src/converters/register-converters.js';
import { handleStreamRequest } from '../src/utils/common.js';
import { kiroIntegrityError } from '../src/providers/claude/kiro-event-stream.js';
import * as services from '../src/services/service-manager.js';
import { frame, service, openStream, bounded } from './helpers/kiro-safety-fixtures.js';

const model = 'claude-sonnet-4-5';
const start = { type: 'message_start', message: { id: 'msg_writer', type: 'message', role: 'assistant',
    model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } };
const tool = { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_writer', name: 'record_probe', input: {} } };
const args = { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"value":' } };
const response = () => {
    const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, headersSent: false });
    res.writeHead = jest.fn(() => { res.headersSent = true; });
    res.flushHeaders = jest.fn(); res.write = jest.fn(() => true);
    res.end = jest.fn(() => { res.writableEnded = true; });
    res.destroy = jest.fn(() => { res.destroyed = true; res.emit('close'); });
    return res;
};
const manager = () => ({ releaseSlot: jest.fn(), markProviderUnhealthy: jest.fn(), markProviderHealthy: jest.fn() });
const run = (res, backend, protocol = 'claude', config = {}) => handleStreamRequest(res, backend, model,
    { messages: [{ role: 'user', content: 'hello' }] }, protocol, 'claude-kiro-oauth', 'none', null, manager(), 'node', null,
    { CONFIG: { SSE_HEARTBEAT_INTERVAL_MS: 0, EMPTY_RESPONSE_MAX_RETRIES: 0, ...config }, maxRetries: 0 });
afterEach(() => jest.restoreAllMocks());

test.each(['claude', 'openai', 'openaiResponses'])('%s reports accepted partial tools and never retries the response', async protocol => {
    const retry = jest.spyOn(services, 'getApiServiceWithFallback');
    const error = Object.assign(kiroIntegrityError('incomplete tool argument JSON'), { kiroIncrementalToolFailure: true });
    const backend = { generateContentStream: jest.fn(async function* () {
        yield start; yield tool; yield args; throw error;
    }) };
    const res = response(); await run(res, backend, protocol);
    const wire = res.write.mock.calls.map(([record]) => record).join('');
    expect(wire).toContain('Partial tool data was already sent.');
    expect(wire).toContain('Do not execute incomplete arguments');
    expect(wire).not.toContain('No malformed tool call was emitted.');
    expect(error.recoveryHint).toContain('Partial tool data was already sent.');
    expect(backend.generateContentStream).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
});

test('sending only message_start does not falsely claim tool data was sent', async () => {
    const error = Object.assign(kiroIntegrityError('incomplete tool argument JSON'), { kiroIncrementalToolFailure: true });
    const backend = { generateContentStream: async function* () { yield start; throw error; } };
    const res = response(); await run(res, backend);
    const wire = res.write.mock.calls.map(([record]) => record).join('');
    expect(wire).toContain('No malformed tool call was emitted.');
    expect(wire).not.toContain('Partial tool data was already sent.');
});

test('specific conflicting-snapshot advice survives the writer status update', async () => {
    const specific = 'Do not execute or repair the failed tool call because the argument snapshot conflicts with the emitted prefix.';
    const error = Object.assign(new Error(`Kiro argument snapshot conflict. ${specific}`), {
        status: 502, recoveryHint: specific, kiroIncrementalToolFailure: true
    });
    const backend = { generateContentStream: async function* () { yield start; yield tool; throw error; } };
    const res = response(); await run(res, backend);
    expect(error.recoveryHint).toContain(specific);
    expect(error.recoveryHint).toContain('Partial tool data was already sent.');
    expect(res.write.mock.calls.map(([record]) => record).join('')).toContain(specific);
});

test('an earlier closed call cannot prove a different failed tool was written', async () => {
    const error = Object.assign(kiroIntegrityError('incomplete tool argument JSON'), {
        kiroIncrementalToolFailure: true, kiroToolCallId: 'call_unwritten'
    });
    const backend = { generateContentStream: async function* () {
        yield start; yield tool; yield { type: 'content_block_stop', index: 0 };
        throw error;
    } };
    const res = response(); await run(res, backend);
    const wire = res.write.mock.calls.map(([record]) => record).join('');
    expect(wire).toContain('No malformed tool call was emitted.');
    expect(wire).not.toContain('Partial tool data was already sent.');
});

test('an earlier call left open is partial even when the error names a different unwritten call', async () => {
    const error = Object.assign(kiroIntegrityError('incomplete tool argument JSON'), {
        kiroIncrementalToolFailure: true, kiroToolCallId: 'call_unwritten'
    });
    const backend = { generateContentStream: async function* () { yield start; yield tool; throw error; } };
    const res = response(); await run(res, backend);
    const wire = res.write.mock.calls.map(([record]) => record).join('');
    expect(wire).toContain('Partial tool data was already sent.');
    expect(wire).not.toContain('No malformed tool call was emitted.');
});

test('a transport error after a completed tool keeps its specific recovery advice', async () => {
    const error = Object.assign(kiroIntegrityError('truncated trailing event frame'), { kiroIncrementalToolFailure: true });
    const backend = { generateContentStream: async function* () {
        yield start; yield tool; yield { type: 'content_block_stop', index: 0 }; throw error;
    } };
    const res = response(); await run(res, backend);
    const wire = res.write.mock.calls.map(([record]) => record).join('');
    expect(wire).toContain('transport ended with an incomplete event frame');
    expect(wire).not.toContain('Partial tool data was already sent.');
});

test('a failed tool write cancels generation without claiming it was accepted or replaying', async () => {
    const retry = jest.spyOn(services, 'getApiServiceWithFallback');
    let signal;
    const error = Object.assign(kiroIntegrityError('incomplete tool argument JSON'), { kiroIncrementalToolFailure: true });
    const backend = { generateContentStream: async function* (_, body, options) {
        signal = options.signal; yield start; yield tool; throw error;
    } };
    const res = response();
    res.write.mockImplementation(record => {
        if (record.includes('"type":"tool_use"')) throw new Error('client stopped');
        return true;
    });
    await run(res, backend);
    expect(signal.aborted).toBe(true);
    expect(retry).not.toHaveBeenCalled();
    expect(res.write.mock.calls.map(([record]) => record).join('')).not.toContain('Partial tool data was already sent.');
});

const records = record => record.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)));
const argumentText = chunk => chunk.delta?.type === 'input_json_delta' ? chunk.delta.partial_json
    : chunk.type === 'response.function_call_arguments.delta' ? chunk.delta
        : chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments;
const toolFrame = data => frame('toolUseEvent', { toolUseId: 'live_writer', ...data });

describe.each(['claude', 'openai', 'openaiResponses'])('%s live Kiro incremental writer', protocol => {
    const begin = (onArguments = () => true, config = {}) => {
        const source = openStream(), res = response();
        const backend = service([], { KIRO_TOOL_STREAM_MODE: 'incremental' });
        backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: source });
        let accepted;
        const firstArguments = new Promise(resolve => { accepted = resolve; });
        res.write.mockImplementation(record => {
            const argument = records(record).map(argumentText).find(value => value);
            if (argument) { accepted(argument); return onArguments(); }
            return true;
        });
        const operation = run(res, backend, protocol, config);
        source.push(toolFrame({ name: 'record_probe', input: '' }));
        source.push(toolFrame({ input: '{"value":' }));
        return { source, res, backend, firstArguments, operation };
    };

    test('forwards multiple parameter fragments while upstream is still open', async () => {
        const live = begin();
        await expect(bounded(live.firstArguments)).resolves.toBe('{"value":');
        expect(live.res.writableEnded).toBe(false);
        live.source.push(toolFrame({ input: '1}', stop: true })); live.source.push(null);
        await bounded(live.operation);
        const sent = live.res.write.mock.calls.flatMap(([record]) => records(record)).map(argumentText).filter(value => value);
        expect(sent).toEqual(['{"value":', '1}']);
        expect(live.backend._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
    });

    test('an incomplete upstream tool after a sent fragment ends with an accurate error and no replay', async () => {
        const retry = jest.spyOn(services, 'getApiServiceWithFallback');
        const live = begin();
        await bounded(live.firstArguments);
        live.source.push(null); await bounded(live.operation);
        const wire = live.res.write.mock.calls.map(([record]) => record).join('');
        expect(wire).toContain('Partial tool data was already sent.');
        expect(wire).not.toContain('No malformed tool call was emitted.');
        expect(live.backend._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
        expect(retry).not.toHaveBeenCalled();
    });

    test('a later call exceeding the argument budget while an earlier call is open reports partial data', async () => {
        const source = openStream(), res = response();
        const backend = service([], { KIRO_TOOL_STREAM_MODE: 'incremental', KIRO_MAX_TOOL_ARGUMENT_BYTES: 64 });
        backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: source });
        const operation = run(res, backend, protocol);
        source.push(toolFrame({ name: 'record_probe', input: '' }));
        source.push(toolFrame({ input: '{"value":' }));
        // The budget error names this second call, which never reaches the writer.
        source.push(frame('toolUseEvent', { toolUseId: 'live_second', name: 'record_probe', input: 'x'.repeat(80) }));
        source.push(null);
        await bounded(operation);
        const sent = res.write.mock.calls.flatMap(([record]) => records(record)).map(argumentText).filter(value => value);
        expect(sent).toEqual(['{"value":']);
        const wire = res.write.mock.calls.map(([record]) => record).join('');
        expect(wire).toContain('tool argument buffer limit exceeded');
        expect(wire).toContain('Partial tool data was already sent.');
    });

    test('an argument write that never drains cancels upstream at the write deadline', async () => {
        const retry = jest.spyOn(services, 'getApiServiceWithFallback');
        const live = begin(() => false, { KIRO_DOWNSTREAM_WRITE_TIMEOUT_MS: 20 });
        await bounded(live.firstArguments); await bounded(live.operation);
        expect(live.source.destroyed).toBe(true);
        expect(live.res.destroyed).toBe(true);
        expect(live.res.listenerCount('drain')).toBe(0);
        expect(retry).not.toHaveBeenCalled();
    });

    test('client cancellation during an unfinished tool closes upstream and does not replay', async () => {
        const retry = jest.spyOn(services, 'getApiServiceWithFallback');
        const live = begin();
        await bounded(live.firstArguments);
        live.res.destroyed = true; live.res.emit('close'); await bounded(live.operation);
        expect(live.source.destroyed).toBe(true);
        expect(live.res.listenerCount('drain')).toBe(0);
        expect(retry).not.toHaveBeenCalled();
        expect(live.res.write.mock.calls.map(([record]) => record).join('')).not.toContain('Partial tool data was already sent.');
    });
});
