import { EventEmitter, getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import * as http from 'node:http';
import * as https from 'node:https';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import logger from '../src/utils/logger.js';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { KiroApiServiceAdapter } from '../src/providers/adapter.js';
import * as serviceManager from '../src/services/service-manager.js';
import { handleStreamRequest, handleUnifiedResponse } from '../src/utils/common.js';

const MODEL = 'claude-sonnet-4-5';
const request = () => ({ messages: [{ role: 'user', content: 'hello' }] });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function waitFor(predicate, ms = 1000) {
    const deadline = performance.now() + ms;
    while (!predicate()) {
        if (performance.now() > deadline) throw new Error('Condition was not met');
        await nextTurn();
    }
}

const logged = (method, text) => () => logger[method].mock.calls.some(([message]) => String(message).includes(text));

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function bounded(promise, ms = 1000) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Stream operation did not settle')), ms);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function awsFrame(eventType, payload) {
    const name = Buffer.from(':event-type');
    const value = Buffer.from(eventType);
    const valueLength = Buffer.alloc(2);
    valueLength.writeUInt16BE(value.length);
    const headers = Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7]), valueLength, value]);
    const data = Buffer.from(JSON.stringify(payload));
    const frame = Buffer.alloc(16 + headers.length + data.length);
    frame.writeUInt32BE(frame.length, 0);
    frame.writeUInt32BE(headers.length, 4);
    frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
    headers.copy(frame, 12);
    data.copy(frame, 12 + headers.length);
    frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
    return frame;
}

const textFrame = content => awsFrame('assistantResponseEvent', { content });
const openStream = () => new Readable({ read() {} });

function createService(config = {}) {
    const service = Object.create(KiroApiService.prototype);
    Object.assign(service, {
        config: { REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 1, ...config },
        isInitialized: true,
        accessToken: 'mock-token',
        baseUrl: 'https://mock.invalid/generateAssistantResponse',
        _applySidecar: jest.fn(),
        _prepareAccessTokenForRequest: jest.fn(async () => {}),
        buildCodewhispererRequest: jest.fn(async () => ({})),
        estimateInputTokens: jest.fn(() => 1),
        countTextTokens: jest.fn(text => text.length),
        _requestWithBuilderEndpointRouting: jest.fn(async () => ({ data: Readable.from([textFrame('hello')]) }))
    });
    return service;
}

async function collect(iterator) {
    const chunks = [];
    for await (const chunk of iterator) chunks.push(chunk);
    return chunks;
}

async function firstText(iterator) {
    while (true) {
        const { value, done } = await iterator.next();
        if (done) throw new Error('Stream ended before visible text');
        if (value.delta?.type === 'text_delta') return value.delta.text;
    }
}

function responseMock() {
    const response = new EventEmitter();
    response.writableEnded = false;
    response.writeHead = jest.fn();
    response.flushHeaders = jest.fn();
    response.write = jest.fn(() => true);
    response.end = jest.fn(() => { response.writableEnded = true; });
    return response;
}

function adapterFor(service) {
    const adapter = Object.create(KiroApiServiceAdapter.prototype);
    adapter.kiroApiService = service;
    return adapter;
}

function runHandler(service, response, pool = null, retryContext = { CONFIG: {}, maxRetries: 0 }) {
    return handleStreamRequest(
        response, adapterFor(service), MODEL, request(), 'claude', 'claude-kiro-oauth',
        'none', null, pool, pool ? 'test-account' : null, null, retryContext
    );
}

describe('Kiro streaming latency and lifecycle', () => {
    beforeEach(() => jest.clearAllMocks());
    afterEach(() => jest.restoreAllMocks());

    test('emits real text before upstream EOF and parses split UTF-8 frames', async () => {
        const service = createService();
        const upstream = openStream();
        const frame = textFrame('首字');
        upstream.push(frame.subarray(0, 9));
        service._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
        const iterator = service.generateContentStream(MODEL, request());
        const pendingText = firstText(iterator);
        await nextTurn();
        upstream.push(frame.subarray(9));
        try {
            expect(await bounded(pendingText)).toBe('首字');
            expect(upstream.readableEnded).toBe(false);
            upstream.push(textFrame('后续'));
            upstream.push(null);
            const remaining = await bounded(collect(iterator));
            expect(remaining.some(chunk => chunk.delta?.text === '后续')).toBe(true);
            expect(remaining.at(-1)).toEqual({ type: 'message_stop' });
        } finally {
            upstream.destroy();
            await iterator.return();
        }
    });

    test('start intervals do not serialize active streams across accounts', async () => {
        const interval = 25;
        const started = [];
        const services = ['a', 'b', 'c'].map(uuid => createService({ uuid, KIRO_REQUEST_MIN_INTERVAL_MS: interval }));
        const upstreams = services.map(() => openStream());
        const iterators = services.map(service => service.streamApiReal('', MODEL, request()));
        services.forEach((service, index) => {
            upstreams[index].push(textFrame(`account-${index}`));
            service._requestWithBuilderEndpointRouting.mockImplementation(async () => {
                started.push(performance.now());
                return { data: upstreams[index] };
            });
        });
        try {
            await bounded(iterators[0].next());
            await bounded(Promise.all([iterators[1].next(), iterators[2].next()]));
            expect(started).toHaveLength(3);
            expect(started[1] - started[0]).toBeGreaterThanOrEqual(interval - 2);
            expect(started[2] - started[1]).toBeGreaterThanOrEqual(interval - 2);
            expect(upstreams[0].destroyed).toBe(false);
        } finally {
            upstreams.forEach(stream => stream.destroy());
            await Promise.all(iterators.map(iterator => iterator.return()));
        }
    });

    test('buffered requests do not hold the start interval until their response finishes', async () => {
        const buffered = createService({ KIRO_REQUEST_MIN_INTERVAL_MS: 10 });
        const streaming = createService({ KIRO_REQUEST_MIN_INTERVAL_MS: 10 });
        const entered = deferred(), response = deferred();
        buffered._requestWithBuilderEndpointRouting.mockImplementation(() => {
            entered.resolve();
            return response.promise;
        });
        const bufferedRequest = buffered.callApi('', MODEL, request());
        const iterator = streaming.streamApiReal('', MODEL, request());
        try {
            await bounded(entered.promise);
            expect((await bounded(iterator.next())).value.content).toBe('hello');
        } finally {
            response.resolve({ data: 'done' });
            await bufferedRequest;
            await iterator.return();
        }
    });

    test('network retries with throttling enabled complete without a lock cycle', async () => {
        const service = createService({ KIRO_REQUEST_MIN_INTERVAL_MS: 10 });
        const controller = new AbortController();
        service._requestWithBuilderEndpointRouting.mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
        const chunks = await bounded(collect(service.streamApiReal('', MODEL, request(), false, 0, { signal: controller.signal })));
        expect(chunks).toEqual([{ type: 'content', content: 'hello' }]);
        expect(service._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(2);
        for (const [config] of service._requestWithBuilderEndpointRouting.mock.calls) expect(config.signal.aborted).toBe(true);
        expect(controller.signal.aborted).toBe(false);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    test('returning the outer iterator closes the upstream and removes abort listeners', async () => {
        const service = createService();
        const upstream = openStream();
        const controller = new AbortController();
        upstream.push(textFrame('hello'));
        service._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
        const iterator = service.generateContentStream(MODEL, request(), { signal: controller.signal });
        expect((await bounded(iterator.next())).value.type).toBe('message_start');
        await bounded(iterator.return());
        expect(upstream.destroyed).toBe(true);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    test('a stream reset after visible text is not replayed', async () => {
        const service = createService({ KIRO_REQUEST_MIN_INTERVAL_MS: 1 });
        const upstream = openStream();
        upstream.push(textFrame('already sent'));
        service._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
        const iterator = service.generateContentStream(MODEL, request());
        expect(await bounded(firstText(iterator))).toBe('already sent');
        upstream.destroy(Object.assign(new Error('reset after output'), { code: 'ECONNRESET' }));
        await expect(bounded(iterator.next())).rejects.toMatchObject({ code: 'ECONNRESET' });
        expect(service._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
    });

    test('aborted queued reservations reject promptly without poisoning the queue', async () => {
        const seed = createService({ KIRO_REQUEST_MIN_INTERVAL_MS: 1 });
        await collect(seed.streamApiReal('', MODEL, request()));
        const waiting = createService({ KIRO_REQUEST_MIN_INTERVAL_MS: 2000 });
        const behind = createService({ KIRO_REQUEST_MIN_INTERVAL_MS: 2000 });
        const first = new AbortController(), second = new AbortController();
        const waitingResult = waiting.streamApiReal('', MODEL, request(), false, 0, { signal: first.signal }).next();
        // Install rejection handlers before aborting either request.
        const waitingExpectation = expect(bounded(waitingResult)).rejects.toMatchObject({ name: 'AbortError' });
        await nextTurn();
        const behindResult = behind.streamApiReal('', MODEL, request(), false, 0, { signal: second.signal }).next();
        const behindExpectation = expect(bounded(behindResult)).rejects.toMatchObject({ name: 'AbortError' });
        second.abort();
        await behindExpectation;
        expect(waiting._requestWithBuilderEndpointRouting).not.toHaveBeenCalled();
        first.abort();
        await waitingExpectation;
        expect(behind._requestWithBuilderEndpointRouting).not.toHaveBeenCalled();
        const following = createService({ KIRO_REQUEST_MIN_INTERVAL_MS: 1 });
        expect(await bounded(collect(following.streamApiReal('', MODEL, request())))).toEqual([{ type: 'content', content: 'hello' }]);
    });

    test('abort during network backoff prevents the next attempt', async () => {
        const service = createService({ REQUEST_BASE_DELAY: 2000 });
        const attempted = deferred();
        const controller = new AbortController();
        service._requestWithBuilderEndpointRouting.mockImplementation(async () => {
            attempted.resolve();
            throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        });
        const pending = service.generateContentStream(MODEL, request(), { signal: controller.signal }).next();
        const rejection = expect(bounded(pending)).rejects.toMatchObject({ name: 'AbortError' });
        await attempted.promise;
        await nextTurn();
        controller.abort();
        await rejection;
        expect(service._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
    });

    test('abort during shared token preparation stops the request without cancelling the shared work', async () => {
        const service = createService();
        const entered = deferred(), sharedWork = deferred();
        service._prepareAccessTokenForRequest.mockImplementation(() => {
            entered.resolve();
            return sharedWork.promise;
        });
        const controller = new AbortController();
        const pending = service.generateContentStream(MODEL, request(), { signal: controller.signal }).next();
        const rejection = expect(bounded(pending)).rejects.toMatchObject({ name: 'AbortError' });
        await entered.promise;
        controller.abort();
        await rejection;
        sharedWork.resolve();
        await nextTurn();
        expect(service._requestWithBuilderEndpointRouting).not.toHaveBeenCalled();
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    test('pre-aborted requests never initialize or contact upstream', async () => {
        const service = createService();
        service.isInitialized = false;
        service.initialize = jest.fn();
        const controller = new AbortController();
        controller.abort();
        await expect(service.generateContentStream(MODEL, request(), { signal: controller.signal }).next()).rejects.toMatchObject({ name: 'AbortError' });
        expect(service.initialize).not.toHaveBeenCalled();
        expect(service._requestWithBuilderEndpointRouting).not.toHaveBeenCalled();
    });

    test('abort during cold initialization returns promptly and never starts generation', async () => {
        const service = createService();
        service.isInitialized = false;
        const entered = deferred(), initialization = deferred();
        service.initialize = jest.fn(() => { entered.resolve(); return initialization.promise; });
        const controller = new AbortController();
        const pending = service.generateContentStream(MODEL, request(), { signal: controller.signal }).next();
        const rejection = expect(bounded(pending)).rejects.toMatchObject({ name: 'AbortError' });
        await entered.promise;
        controller.abort();
        await rejection;
        initialization.resolve();
        await nextTurn();
        expect(service._prepareAccessTokenForRequest).not.toHaveBeenCalled();
        expect(service._requestWithBuilderEndpointRouting).not.toHaveBeenCalled();
    });

    test('empty upstream responses still reject before forwarding message_start', async () => {
        const service = createService();
        service._requestWithBuilderEndpointRouting.mockResolvedValue({ data: Readable.from([]) });
        await expect(service.generateContentStream(MODEL, request()).next()).rejects.toMatchObject({ isEmptyUpstreamResponse: true });
    });

    test('native reasoning and inline thinking still stream separately from visible text', async () => {
        for (const frames of [
            [awsFrame('reasoningContentEvent', { text: 'considering' }), textFrame('answer')],
            [textFrame('<thinking>considering</thinking>\n\nanswer')]
        ]) {
            const service = createService();
            service._requestWithBuilderEndpointRouting.mockResolvedValue({ data: Readable.from(frames) });
            const chunks = await collect(service.generateContentStream(MODEL, { ...request(), thinking: { type: 'enabled', budget_tokens: 1024 } }));
            expect(chunks.filter(chunk => chunk.delta?.type === 'thinking_delta').map(chunk => chunk.delta.thinking).join('')).toBe('considering');
            expect(chunks.filter(chunk => chunk.delta?.type === 'text_delta').map(chunk => chunk.delta.text).join('')).toBe('answer');
        }
    });

    test('tool calls retain streamed JSON fragments and their stop reason', async () => {
        const service = createService();
        service._requestWithBuilderEndpointRouting.mockResolvedValue({ data: Readable.from([
            awsFrame('toolUseEvent', { name: 'lookup', toolUseId: 'tool-1', input: '{"q":' }),
            awsFrame('toolUseEvent', { input: '"example"}' }),
            awsFrame('toolUseEvent', { stop: true })
        ]) });
        const chunks = await collect(service.generateContentStream(MODEL, request()));
        expect(chunks.find(chunk => chunk.content_block?.type === 'tool_use').content_block).toMatchObject({ id: 'tool-1', name: 'lookup' });
        const json = chunks.filter(chunk => chunk.delta?.type === 'input_json_delta').map(chunk => chunk.delta.partial_json).join('');
        expect(JSON.parse(json)).toEqual({ q: 'example' });
        expect(chunks.find(chunk => chunk.type === 'message_delta').delta.stop_reason).toBe('tool_use');
    });

    test('reports queue, upstream event, and visible-text timings without logging content', async () => {
        const service = createService();
        await collect(service.generateContentStream(MODEL, request()));
        const logs = logger.info.mock.calls.map(([message]) => message);
        expect(logs.some(message => /Upstream headers: \d+ms; queue: \d+ms/.test(message))).toBe(true);
        expect(logs.filter(message => /First upstream content event: \d+ms/.test(message))).toHaveLength(1);
        expect(logs.filter(message => /First visible text: \d+ms; prior thinking: false/.test(message))).toHaveLength(1);
        expect(logs.some(message => message.includes('hello'))).toBe(false);
    });

    test('real Axios streaming requests reuse a connection to a local mock upstream', async () => {
        const connections = new Set();
        const connectionHeaders = [];
        const server = http.createServer((req, res) => {
            connectionHeaders.push(req.headers.connection);
            req.resume();
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/vnd.amazon.eventstream' });
                res.end(textFrame('local answer'));
            });
        });
        server.on('connection', socket => connections.add(socket));
        try {
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            const service = createService();
            service.isInitialized = false;
            service.loadCredentials = jest.fn(async () => {});
            await service.initialize();
            service.baseUrl = `http://127.0.0.1:${server.address().port}/generateAssistantResponse`;
            // Use the real Axios transport, with no external proxy or credentials.
            service._requestWithBuilderEndpointRouting = KiroApiService.prototype._requestWithBuilderEndpointRouting;
            service._applySidecar = config => { config.proxy = false; };
            for (let call = 0; call < 2; call++) {
                const chunks = await bounded(collect(service.generateContentStream(MODEL, request())));
                expect(chunks.filter(chunk => chunk.delta?.type === 'text_delta').map(chunk => chunk.delta.text).join('')).toBe('local answer');
            }
            expect(connectionHeaders).toEqual(['keep-alive', 'keep-alive']);
            expect(connections.size).toBe(1);
        } finally {
            for (const socket of connections) socket.destroy();
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('initialization uses shared keep-alive agents instead of forcing Connection: close', async () => {
        const service = createService();
        service.isInitialized = false;
        service.loadCredentials = jest.fn(async () => {});
        await service.initialize();
        expect(service.axiosInstance.defaults.httpAgent).toBe(http.globalAgent);
        expect(service.axiosInstance.defaults.httpsAgent).toBe(https.globalAgent);
        expect(http.globalAgent.keepAlive).toBe(true);
        expect(https.globalAgent.keepAlive).toBe(true);
        expect(service.axiosInstance.defaults.headers.Connection).toBeUndefined();
    });
});

describe('SSE cancellation reaches the Kiro transport', () => {
    beforeEach(() => jest.clearAllMocks());
    afterEach(() => jest.restoreAllMocks());

    test('SSE headers are flushed and proxy buffering is disabled without model data', async () => {
        const response = responseMock();
        await handleUnifiedResponse(response, '', true);
        expect(response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache, no-transform'
        }));
        expect(response.flushHeaders).toHaveBeenCalledTimes(1);
        expect(response.write).not.toHaveBeenCalled();
        expect(response.end).not.toHaveBeenCalled();
    });

    test('non-stream responses are unaffected by SSE flushing', async () => {
        const response = responseMock();
        await handleUnifiedResponse(response, '{"ok":true}', false, 201);
        expect(response.writeHead).toHaveBeenCalledWith(201, { 'Content-Type': 'application/json' });
        expect(response.flushHeaders).not.toHaveBeenCalled();
        expect(response.end).toHaveBeenCalledWith('{"ok":true}');
    });

    test('disconnect before upstream headers cancels Axios rather than waiting for a token', async () => {
        const service = createService();
        const entered = deferred();
        let upstreamSignal;
        service._requestWithBuilderEndpointRouting.mockImplementation(({ signal }) => {
            upstreamSignal = signal;
            entered.resolve();
            return new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        });
        const response = responseMock();
        const pool = { releaseSlot: jest.fn(), markProviderHealthy: jest.fn(), markProviderUnhealthy: jest.fn() };
        const pending = runHandler(service, response, pool);
        await bounded(entered.promise);
        expect(response.flushHeaders).toHaveBeenCalledTimes(1);
        response.emit('close');
        await bounded(pending);
        expect(upstreamSignal.aborted).toBe(true);
        expect(service._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
        expect(response.write).not.toHaveBeenCalled();
        expect(pool.releaseSlot).toHaveBeenCalledWith('claude-kiro-oauth', 'test-account');
        expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(response.listenerCount('close')).toBe(0);
    });

    test('disconnect while the upstream is silent destroys it and finishes promptly', async () => {
        const service = createService();
        const upstream = openStream();
        const entered = deferred();
        service._requestWithBuilderEndpointRouting.mockImplementation(async () => {
            entered.resolve();
            return { data: upstream };
        });
        const response = responseMock();
        const pending = runHandler(service, response);
        await bounded(entered.promise);
        await nextTurn();
        response.emit('close');
        await bounded(pending);
        expect(upstream.destroyed).toBe(true);
        expect(response.write).not.toHaveBeenCalled();
        expect(service._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
    });

    test('flushing headers preserves empty-response retries and one shared cancellation signal', async () => {
        const empty = createService(), successful = createService();
        const firstRaw = jest.spyOn(empty, '_generateContentStreamRaw');
        const secondRaw = jest.spyOn(successful, '_generateContentStreamRaw');
        const signals = [];
        empty._requestWithBuilderEndpointRouting.mockImplementation(async ({ signal }) => {
            signals.push(signal);
            return { data: Readable.from([]) };
        });
        successful._requestWithBuilderEndpointRouting.mockImplementation(async ({ signal }) => {
            signals.push(signal);
            return { data: Readable.from([textFrame('retried answer')]) };
        });
        jest.spyOn(serviceManager, 'getApiServiceWithFallback').mockResolvedValue({
            service: adapterFor(successful), actualProviderType: 'claude-kiro-oauth', actualModel: MODEL
        });
        const response = responseMock();
        await bounded(runHandler(empty, response, null, {
            CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1, EMPTY_RESPONSE_RETRY_DELAY_MS: 0 }, maxRetries: 0
        }));
        expect(serviceManager.getApiServiceWithFallback).toHaveBeenCalledTimes(1);
        expect(response.flushHeaders).toHaveBeenCalledTimes(1);
        expect(response.write.mock.calls.filter(([text]) => text === 'event: message_start\n')).toHaveLength(1);
        expect(response.write.mock.calls.some(([text]) => text.includes('retried answer'))).toBe(true);
        expect(signals).toHaveLength(2);
        expect(firstRaw.mock.calls[0][2].signal).toBe(secondRaw.mock.calls[0][2].signal);
        expect(signals.every(signal => signal.aborted)).toBe(true);
        expect(signals[0].aborted).toBe(true);
    });

    test('disconnect also cancels an upstream request started by an empty-response retry', async () => {
        const empty = createService(), retry = createService();
        const firstRaw = jest.spyOn(empty, '_generateContentStreamRaw');
        const secondRaw = jest.spyOn(retry, '_generateContentStreamRaw');
        const signals = [];
        const entered = deferred();
        empty._requestWithBuilderEndpointRouting.mockImplementation(async ({ signal }) => {
            signals.push(signal);
            return { data: Readable.from([]) };
        });
        retry._requestWithBuilderEndpointRouting.mockImplementation(({ signal }) => {
            signals.push(signal);
            entered.resolve();
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        });
        jest.spyOn(serviceManager, 'getApiServiceWithFallback').mockResolvedValue({
            service: adapterFor(retry), actualProviderType: 'claude-kiro-oauth', actualModel: MODEL
        });
        const response = responseMock();
        const pending = runHandler(empty, response, null, {
            CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1, EMPTY_RESPONSE_RETRY_DELAY_MS: 0 }, maxRetries: 0
        });
        await bounded(entered.promise);
        response.emit('close');
        await bounded(pending);
        expect(firstRaw.mock.calls[0][2].signal).toBe(secondRaw.mock.calls[0][2].signal);
        expect(signals[1].aborted).toBe(true);
        expect(response.write).not.toHaveBeenCalled();
        expect(retry._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
        expect(response.listenerCount('close')).toBe(0);
    });

    test('a downstream write error cancels a still-active upstream stream', async () => {
        const service = createService();
        const upstream = openStream();
        upstream.push(textFrame('answer'));
        service._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
        const response = responseMock();
        response.write.mockImplementation(() => { throw new Error('downstream socket failed'); });
        await bounded(runHandler(service, response));
        expect(upstream.destroyed).toBe(true);
        expect(service._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
    });

    test('an already-disconnected response does not start upstream generation', async () => {
        const service = createService();
        const response = responseMock();
        response.destroyed = true;
        const pool = { releaseSlot: jest.fn(), markProviderHealthy: jest.fn(), markProviderUnhealthy: jest.fn() };
        await bounded(runHandler(service, response, pool));
        expect(service._requestWithBuilderEndpointRouting).not.toHaveBeenCalled();
        expect(response.flushHeaders).not.toHaveBeenCalled();
        expect(pool.releaseSlot).toHaveBeenCalledTimes(1);
        expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
    });

    test('header flush failures release the account slot without penalizing its credentials', async () => {
        const service = createService();
        const response = responseMock();
        response.flushHeaders.mockImplementation(() => { throw new Error('closed downstream socket'); });
        const pool = { releaseSlot: jest.fn(), markProviderHealthy: jest.fn(), markProviderUnhealthy: jest.fn() };
        await bounded(runHandler(service, response, pool));
        expect(service._requestWithBuilderEndpointRouting).not.toHaveBeenCalled();
        expect(response.write).not.toHaveBeenCalled();
        expect(pool.releaseSlot).toHaveBeenCalledTimes(1);
        expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(response.listenerCount('close')).toBe(0);
    });

    test('disconnect during the credential-switch delay skips acquiring a new slot', async () => {
        const service = createService();
        service._requestWithBuilderEndpointRouting.mockRejectedValue(
            Object.assign(new Error('switch me'), { shouldSwitchCredential: true, skipErrorCount: true })
        );
        jest.spyOn(Math, 'random').mockReturnValue(0.5); // 5s 随机等待
        const fallback = jest.spyOn(serviceManager, 'getApiServiceWithFallback');
        const pool = { releaseSlot: jest.fn(), markProviderHealthy: jest.fn(), markProviderUnhealthy: jest.fn() };
        const response = responseMock();
        const pending = runHandler(service, response, pool, { CONFIG: {}, maxRetries: 1 });
        await waitFor(logged('info', 'Credential marked unhealthy. Waiting'));
        response.emit('close');
        await bounded(pending);
        expect(fallback).not.toHaveBeenCalled();
        expect(response.write).not.toHaveBeenCalled();
        expect(response.end).not.toHaveBeenCalled();
        expect(pool.releaseSlot).toHaveBeenCalledTimes(1);
        expect(response.listenerCount('close')).toBe(0);
    });

    test('disconnect during the empty-response retry delay skips acquiring a new slot', async () => {
        const service = createService();
        service._requestWithBuilderEndpointRouting.mockImplementation(async () => ({ data: Readable.from([]) }));
        const fallback = jest.spyOn(serviceManager, 'getApiServiceWithFallback');
        const response = responseMock();
        const pending = runHandler(service, response, null, {
            CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1, EMPTY_RESPONSE_RETRY_DELAY_MS: 5000 }, maxRetries: 0
        });
        await waitFor(logged('warn', 'Retrying with the same request body'));
        response.emit('close');
        await bounded(pending);
        expect(fallback).not.toHaveBeenCalled();
        expect(response.write).not.toHaveBeenCalled();
        expect(response.end).not.toHaveBeenCalled();
    });
});


describe('Kiro real HTTP error-response cancellation', () => {
    beforeEach(() => jest.clearAllMocks());
    afterEach(() => jest.restoreAllMocks());

    test.each([400, 401, 402, 403, 429, 503])('disconnect cancels a stalled %i response body and releases the slot exactly once', async status => {
        const sockets = new Set();
        const server = http.createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.write('{"message":"unfinished upstream error');
            });
        });
        server.on('connection', socket => sockets.add(socket));
        let pending;
        try {
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            const service = createService();
            service.isInitialized = false;
            service.loadCredentials = jest.fn(async () => {});
            await service.initialize();
            service.baseUrl = `http://127.0.0.1:${server.address().port}/generateAssistantResponse`;
            service._applySidecar = config => { config.proxy = false; };
            let signal, errorBody;
            service._requestWithBuilderEndpointRouting = jest.fn(async (config, body) => {
                signal = config.signal;
                try {
                    return await KiroApiService.prototype._requestWithBuilderEndpointRouting.call(service, config, body);
                } catch (error) {
                    errorBody = error.response?.data;
                    throw error;
                }
            });
            service._refreshUuid = jest.fn();
            service._markCredentialNeedRefresh = jest.fn();
            service._markCredentialUnhealthy = jest.fn();
            service._markCredentialUnhealthyWithRecovery = jest.fn();
            service.getUsageLimits = jest.fn(async () => ({}));
            const response = responseMock();
            const pool = { releaseSlot: jest.fn(), markProviderHealthy: jest.fn(), markProviderUnhealthy: jest.fn() };
            pending = runHandler(service, response, pool);
            await waitFor(() => errorBody?.readableFlowing === false);
            response.emit('close');
            await bounded(pending);
            expect(signal.aborted).toBe(true);
            expect(errorBody.destroyed).toBe(true);
            expect(pool.releaseSlot).toHaveBeenCalledTimes(1);
            expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
            expect(service._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
            expect(service.getUsageLimits).not.toHaveBeenCalled();
            expect(service._refreshUuid).not.toHaveBeenCalled();
            expect(service._markCredentialNeedRefresh).not.toHaveBeenCalled();
            expect(service._markCredentialUnhealthy).not.toHaveBeenCalled();
            expect(service._markCredentialUnhealthyWithRecovery).not.toHaveBeenCalled();
            expect(response.write).not.toHaveBeenCalled();
            expect(response.listenerCount('close')).toBe(0);
            expect(getEventListeners(signal, 'abort')).toHaveLength(0);
        } finally {
            for (const socket of sockets) socket.destroy();
            await pending;
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('a disconnect racing with HTTP rejection still destroys the unread error body', async () => {
        const service = createService();
        const response = responseMock();
        const body = openStream();
        const error = Object.assign(new Error('HTTP 503'), { response: { status: 503, data: body } });
        let signal;
        service._requestWithBuilderEndpointRouting.mockImplementation(async config => {
            signal = config.signal;
            response.emit('close');
            throw error;
        });
        const pool = { releaseSlot: jest.fn(), markProviderHealthy: jest.fn(), markProviderUnhealthy: jest.fn() };
        await bounded(runHandler(service, response, pool));
        expect(body.destroyed).toBe(true);
        expect(pool.releaseSlot).toHaveBeenCalledTimes(1);
        expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(response.write).not.toHaveBeenCalled();
        expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    });

    test('disconnect cancels the follow-up 402 usage verification request before changing credential health', async () => {
        const sockets = new Set();
        const usageEntered = deferred();
        const server = http.createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                if (req.url.startsWith('/getUsageLimits')) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.write('{"usageBreakdownList":');
                    usageEntered.resolve();
                } else {
                    res.writeHead(402, { 'Content-Type': 'application/json' });
                    res.end('{"message":"quota exceeded"}');
                }
            });
        });
        server.on('connection', socket => sockets.add(socket));
        let pending;
        try {
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            const service = createService();
            service.isInitialized = false;
            service.loadCredentials = jest.fn(async () => {});
            await service.initialize();
            service.baseUrl = `http://127.0.0.1:${server.address().port}/generateAssistantResponse`;
            service._applySidecar = config => { config.proxy = false; };
            service._requestWithBuilderEndpointRouting = KiroApiService.prototype._requestWithBuilderEndpointRouting;
            service._markCredentialUnhealthyWithRecovery = jest.fn();
            service._markCredentialNeedRefresh = jest.fn();
            service._markCredentialUnhealthy = jest.fn();
            const response = responseMock();
            const pool = { releaseSlot: jest.fn(), markProviderHealthy: jest.fn(), markProviderUnhealthy: jest.fn() };
            pending = runHandler(service, response, pool);
            await bounded(usageEntered.promise);
            response.emit('close');
            await bounded(pending);
            expect(pool.releaseSlot).toHaveBeenCalledTimes(1);
            expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
            expect(service._markCredentialUnhealthyWithRecovery).not.toHaveBeenCalled();
            expect(service._markCredentialNeedRefresh).not.toHaveBeenCalled();
            expect(service._markCredentialUnhealthy).not.toHaveBeenCalled();
            expect(response.write).not.toHaveBeenCalled();
        } finally {
            for (const socket of sockets) socket.destroy();
            await pending;
            await new Promise(resolve => server.close(resolve));
        }
    });
});


describe('Kiro completed HTTP errors retain credential handling', () => {
    beforeEach(() => jest.clearAllMocks());

    test.each([401, 402, 403, 429, 503])('a completed %i error still requests credential switching', async status => {
        const service = createService();
        const body = Readable.from(['{"message":"not authorized to access this resource"}']);
        const error = Object.assign(new Error(`HTTP ${status}`), { response: { status, data: body } });
        service._requestWithBuilderEndpointRouting.mockRejectedValue(error);
        service._refreshUuid = jest.fn();
        service._markCredentialNeedRefresh = jest.fn();
        service._markCredentialUnhealthy = jest.fn();
        service._markCredentialUnhealthyWithRecovery = jest.fn();
        service.getUsageLimits = jest.fn(async () => ({ usageBreakdownList: [{ currentUsage: 1, usageLimit: 1 }] }));
        const controller = new AbortController();
        await expect(service.streamApiReal('', MODEL, request(), false, 0, { signal: controller.signal }).next()).rejects.toBe(error);
        expect(error.shouldSwitchCredential).toBe(true);
        expect(error.skipErrorCount).toBe(true);
        expect(body.destroyed).toBe(true);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        if (status === 401) expect(service._markCredentialNeedRefresh).toHaveBeenCalledTimes(1);
        if (status === 402) {
            expect(service.getUsageLimits).toHaveBeenCalledWith({ signal: controller.signal });
            expect(service._markCredentialUnhealthyWithRecovery).toHaveBeenCalledTimes(1);
        }
        if (status === 403) expect(service._markCredentialUnhealthy).toHaveBeenCalledTimes(1);
    });
});


describe('real Axios meaningful-event deadlines', () => {
    test('HTTP 200 headers without model events time out and close only the transport attempt', async () => {
        const sockets = new Set();
        const server = http.createServer((req, res) => {
            req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/vnd.amazon.eventstream' }); res.flushHeaders(); });
        });
        server.on('connection', socket => sockets.add(socket));
        const controller = new AbortController();
        try {
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
            const service = createService({ KIRO_FIRST_EVENT_TIMEOUT_MS: 100 });
            service.isInitialized = false; service.loadCredentials = jest.fn(async () => {}); await service.initialize();
            service.baseUrl = `http://127.0.0.1:${server.address().port}/generateAssistantResponse`;
            service._applySidecar = config => { config.proxy = false; };
            service._requestWithBuilderEndpointRouting = KiroApiService.prototype._requestWithBuilderEndpointRouting;
            await expect(bounded(collect(service.generateContentStream(MODEL, request(), { signal: controller.signal })))).rejects.toMatchObject({ status: 504 });
            expect(controller.signal.aborted).toBe(false);
            expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        } finally {
            controller.abort(); for (const socket of sockets) socket.destroy();
            await new Promise(resolve => server.close(resolve));
        }
    });
});
