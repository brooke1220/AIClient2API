import { getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import { crc32, decodeKiroFrames, decodeKiroFramesResilient } from '../src/providers/claude/kiro-event-stream.js';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { KiroToolAssembler } from '../src/providers/claude/kiro-tool-assembler.js';
import { buildKiroInferenceConfig, guardKiroPayload } from '../src/providers/claude/kiro-request-guards.js';
import TLSSidecar from '../src/utils/tls-sidecar.js';
import { frame, text, tool, request, model, service, collect, openStream, bounded, tick, crc } from './helpers/kiro-safety-fixtures.js';

describe('resilient event prelude scan boundaries', () => {
    test.each([12, 32])('retains %i corrupt bytes when no complete prelude is available', size => {
        const bytes = Buffer.alloc(size);
        expect(decodeKiroFramesResilient(bytes)).toEqual({ frames: [], remaining: bytes, errors: 0 });
    });
    test('retains a split prelude and recovers after the remaining bytes arrive', () => {
        const valid = text('recovered');
        const first = decodeKiroFramesResilient(Buffer.concat([Buffer.alloc(12), valid.subarray(0, 11)]));
        expect(first.frames).toEqual([]);
        const next = decodeKiroFramesResilient(Buffer.concat([first.remaining, valid.subarray(11)]));
        expect(next.frames.map(event => event.data)).toEqual([{ content: 'recovered' }]);
        expect(next.errors).toBe(1);
        expect(next.remaining.length).toBe(0);
    });
    test('finds a complete prelude at the final legal offset and waits for its payload', () => {
        const valid = text('recovered');
        const prelude = valid.subarray(0, 12);
        expect(decodeKiroFramesResilient(Buffer.concat([Buffer.alloc(12), prelude])))
            .toEqual({ frames: [], remaining: prelude, errors: 1 });
    });
});

describe('AWS wire integrity and truthful termination', () => {
    test('CRC matches the standard known vector', () => { expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926); });
    test.each([0, 8, 20])('CRC corruption at byte %i fails without emitting a decoded frame', index => {
        const bytes = text('hello'); bytes[index] ^= 1;
        expect(() => decodeKiroFrames(bytes)).toThrow(/CRC/);
    });
    test('header order is not significant and typed headers cannot hide an exception', () => {
        const bytes = frame(null, { message: 'upstream failure' }, { ':message-type': 'exception', ':exception-type': 'InternalServerException' });
        expect(() => decodeKiroFrames(bytes)).toThrow(/upstream failure/);
    });
    test('header-only unmodeled errors are failures, not empty output', () => {
        expect(() => decodeKiroFrames(frame(null, undefined, { ':message-type': 'error', ':error-code': 'InternalError', ':error-message': 'failed' }))).toThrow(/failed/);
    });
    test('a malicious declared length is rejected from its complete prelude', () => {
        const bytes = text('a'); bytes.writeUInt32BE(0xffffffff, 0); bytes.writeUInt32BE(crc(bytes.subarray(0, 8)), 8);
        expect(() => decodeKiroFrames(bytes.subarray(0, 12))).toThrow(/length/);
    });
    test('invalid UTF-8 with a valid checksum is not silently replaced', () => {
        const bytes = text('x'); bytes[bytes.indexOf(Buffer.from('"x"')) + 1] = 0xff;
        bytes.writeUInt32BE(crc(bytes.subarray(0, -4)), bytes.length - 4);
        expect(() => decodeKiroFrames(bytes)).toThrow(/UTF-8/);
    });
    test('split UTF-8 is decoded only once its entire frame arrives', () => {
        const bytes = text('中文🟢');
        expect(decodeKiroFrames(bytes.subarray(0, -2)).frames).toEqual([]);
        expect(decodeKiroFrames(bytes).frames[0].data.content).toBe('中文🟢');
    });
    test.each(['stream', 'unary'])('%s text followed by an exception cannot become a successful response', async mode => {
        const backend = service([text('prefix'), frame(null, { message: 'failed' }, { ':message-type': 'exception', ':exception-type': 'InternalServerException' })]);
        const operation = mode === 'stream' ? collect(backend.generateContentStream(model, request())) : backend.generateContent(model, request());
        await expect(operation).rejects.toMatchObject({ status: 502, skipErrorCount: true });
    });
    test.each(['stream', 'unary'])('%s EOF with a trailing half-frame fails', async mode => {
        const backend = service([text('prefix'), text('lost suffix').subarray(0, -5)]);
        const operation = mode === 'stream' ? collect(backend.generateContentStream(model, request())) : backend.generateContent(model, request());
        await expect(operation).rejects.toThrow(/truncated/);
    });
    test.each([null, [], 'bad payload'])('invalid event payload %p is a protocol failure, not a credential failure', async payload => {
        await expect(collect(service([frame('assistantResponseEvent', payload)]).generateContentStream(model, request()))).rejects.toMatchObject({ status: 502, skipErrorCount: true });
    });
    test.each([false, 0, ''])('an invalid explicit terminal value %p cannot become a successful end_turn', async stopReason => {
        await expect(collect(service([text('prefix'), frame('metadataEvent', { stopReason })]).generateContentStream(model, request()))).rejects.toThrow(/unsupported/);
    });
    test.each(['unknown-stop', 'constructor', '__proto__'])('explicit unknown stop reason %s cannot be inherited or rewritten into successful end_turn', async stopReason => {
        await expect(collect(service([text('prefix'), frame('metadataEvent', { stopReason })]).generateContentStream(model, request()))).rejects.toThrow(/unsupported/);
    });
    test('real max-token termination and real usage survive conversion to native Claude events', async () => {
        const backend = service([text('partial'), frame('metadataEvent', { stopReason: 'max_tokens', usage: { inputTokens: 10, outputTokens: 4 } })]);
        const events = await collect(backend.generateContentStream(model, request()));
        expect(events.find(e => e.type === 'message_delta')).toMatchObject({ delta: { stop_reason: 'max_tokens' }, usage: { input_tokens: 10, output_tokens: 4 } });
    });
    test('strict terminal checks are opt-in for legacy endpoints', async () => {
        await expect(collect(service([text('valid legacy')]).generateContentStream(model, request()))).resolves.toBeDefined();
        await expect(collect(service([text('partial')], { KIRO_REQUIRE_STOP_REASON: true }).generateContentStream(model, request()))).rejects.toThrow(/stop reason/);
    });
    test('identical adjacent text deltas are preserved', async () => {
        const events = await collect(service([text('ha'), text('ha')]).generateContentStream(model, request()));
        expect(events.filter(e => e.delta?.text).map(e => e.delta.text).join('')).toBe('haha');
    });
});

describe('tool isolation and validation before completion', () => {
    test('interleaved A/B arguments retain their IDs and emit non-overlapping Claude blocks', async () => {
        const backend = service([
            tool({ name: 'a', toolUseId: 'a', input: '{"a":' }), tool({ name: 'b', toolUseId: 'b', input: '{"b":' }),
            tool({ toolUseId: 'a', input: '1}' }), tool({ toolUseId: 'b', input: '2}', stop: true }), tool({ toolUseId: 'a', stop: true })
        ]);
        const events = await collect(backend.generateContentStream(model, request()));
        const args = new Map(); let active;
        for (const e of events) {
            if (e.type === 'content_block_start') { expect(active).toBeUndefined(); active = e.index; }
            if (e.type === 'content_block_stop') { expect(active).toBe(e.index); active = undefined; }
            if (e.delta?.partial_json) args.set(e.index, (args.get(e.index) || '') + e.delta.partial_json);
        }
        expect(events.filter(e => e.content_block?.type === 'tool_use').map(e => e.content_block.id)).toEqual(['a', 'b']);
        expect([...args.values()].map(JSON.parse)).toEqual([{ a: 1 }, { b: 2 }]);
    });
    test.each(['stream', 'unary'])('%s malformed arguments are never completed or repaired to {}', async mode => {
        const backend = service([tool({ name: 'write', toolUseId: 'a', input: '{"path":"cut', stop: true })]);
        const operation = mode === 'stream' ? collect(backend.generateContentStream(model, request())) : backend.generateContent(model, request());
        await expect(operation).rejects.toThrow(/tool argument/);
    });
    test('an explicit argument-free stopped call remains a valid {} call', () => {
        const assembler = new KiroToolAssembler();
        expect(assembler.feed({ name: 'ping', toolUseId: 'a', input: {}, stop: true })[0].input).toEqual({});
    });
    test('complete object snapshots replace fragments instead of concatenating two JSON objects', () => {
        const assembler = new KiroToolAssembler();
        assembler.feed({ name: 'read', toolUseId: 'a', input: '{"path":' });
        expect(assembler.feed({ toolUseId: 'a', input: { path: 'x' }, stop: true })[0].input).toEqual({ path: 'x' });
    });
    test('ambiguous ID-less parallel fragments fail explicitly', () => {
        const assembler = new KiroToolAssembler();
        assembler.feed({ name: 'a', toolUseId: 'a' }); assembler.feed({ name: 'b', toolUseId: 'b' });
        expect(() => assembler.feed({ input: '{}' })).toThrow(/ambiguous/);
    });
    test('a generated opening ID adopts the real ID from a later input fragment', () => {
        const assembler = new KiroToolAssembler(); assembler.feed({ name: 'read', input: '{"path":' });
        const completed = assembler.feed({ toolUseId: 'real', input: '"x"}', stop: true });
        expect(completed[0]).toMatchObject({ toolUseId: 'real', input: { path: 'x' } });
    });
    test('many empty tools cannot bypass the argument or call-count budget', () => {
        const assembler = new KiroToolAssembler(4); assembler.feed({ name: 'a', toolUseId: 'a', stop: true }); assembler.feed({ name: 'b', toolUseId: 'b', stop: true });
        expect(() => assembler.feed({ name: 'c', toolUseId: 'c', stop: true })).toThrow(/limit/);
        const countLimited = new KiroToolAssembler(100, 1); countLimited.feed({ name: 'a', toolUseId: 'a', stop: true });
        expect(() => countLimited.feed({ name: 'b', toolUseId: 'b', stop: true })).toThrow(/count limit/);
    });
    test('pending tool argument storage is bounded', () => {
        const assembler = new KiroToolAssembler(8);
        expect(() => assembler.feed({ name: 'a', toolUseId: 'a', input: 'x'.repeat(9) })).toThrow(/limit/);
    });
});

describe('business endpoint selection precedes transport wrapping', () => {
    test('profileless Builder ID still routes correctly through a real Sidecar wrapper', async () => {
        const backend = service(); backend.authMethod = 'builder-id'; backend.profileArn = null;
        const sidecar = Object.create(TLSSidecar.prototype); Object.assign(sidecar, { isReady: () => true, baseUrl: 'http://127.0.0.1:9090' });
        backend._applySidecar = config => sidecar.wrapAxiosConfig(config);
        backend.axiosInstance = { request: jest.fn(async config => config) };
        const original = { url: 'https://q.us-east-1.amazonaws.com/generateAssistantResponse', data: { profileArn: 'unused' }, headers: {} };
        const result = await KiroApiService.prototype._requestWithBuilderEndpointRouting.call(backend, original, original.data);
        expect(result.url).toBe(sidecar.baseUrl);
        expect(result.headers['X-Target-Url']).toBe(backend.codewhispererBaseUrl);
        expect(result.data.profileArn).toBeUndefined();
        expect(original.url).toContain('q.us-east-1');
    });
    test('an opt-in API Key runtime route changes only the outbound copy', async () => {
        const backend = service([], { KIRO_API_KEY_RUNTIME_ENABLED: true }); backend.accessToken = 'ksk_mock';
        backend.axiosInstance = { request: jest.fn(async config => config) };
        const data = { profileArn: 'unused', conversationState: { currentMessage: { userInputMessage: { origin: 'AI_EDITOR' } } } };
        const result = await KiroApiService.prototype._requestWithBuilderEndpointRouting.call(backend, { url: backend.baseUrl, data, headers: {} }, data);
        expect(result.url).toBe('https://runtime.us-east-1.kiro.dev/');
        expect(result.data.conversationState.currentMessage.userInputMessage.origin).toBe('CLI');
        expect(result.headers.TokenType).toBe('API_KEY');
        expect(data.profileArn).toBe('unused'); expect(data.conversationState.currentMessage.userInputMessage.origin).toBe('AI_EDITOR');
    });
});

describe('independent stream timeout budgets', () => {
    test('metadata-only activity does not disable the first meaningful-event deadline', async () => {
        const upstream = openStream(); upstream.push(frame('contextUsageEvent', { contextUsagePercentage: 1 }));
        const backend = service([], { KIRO_FIRST_EVENT_TIMEOUT_MS: 15 }); backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
        await expect(bounded(collect(backend.generateContentStream(model, request())))).rejects.toMatchObject({ status: 504 });
        expect(upstream.destroyed).toBe(true);
    });
    test('the internal no-tool placeholder cannot disable the first-event deadline', async () => {
        const upstream = openStream(); upstream.push(tool({ name: 'no_tool_available', toolUseId: 'noop', input: '{}' }));
        const backend = service([], { KIRO_FIRST_EVENT_TIMEOUT_MS: 15 }); backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
        await expect(bounded(collect(backend.generateContentStream(model, request())))).rejects.toMatchObject({ status: 504 });
        expect(upstream.destroyed).toBe(true);
    });
    test('idle timeout fires after the consumer asks for more data, not while it applies backpressure', async () => {
        const upstream = openStream(); upstream.push(text('prefix'));
        const backend = service([], { KIRO_STREAM_IDLE_TIMEOUT_MS: 15 }); backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
        const iterator = backend.streamApiReal('', model, request());
        await iterator.next();
        await new Promise(resolve => setTimeout(resolve, 25)); expect(upstream.destroyed).toBe(false);
        await expect(bounded(iterator.next())).rejects.toMatchObject({ status: 504 });
        expect(upstream.destroyed).toBe(true);
    });
    test('an attempt deadline never aborts the shared client cancellation signal', async () => {
        const backend = service([], { KIRO_FIRST_EVENT_TIMEOUT_MS: 15 }); const controller = new AbortController();
        backend._requestWithBuilderEndpointRouting.mockImplementation(({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
        await expect(bounded(collect(backend.generateContentStream(model, request(), { signal: controller.signal })))).rejects.toMatchObject({ status: 504 });
        expect(controller.signal.aborted).toBe(false); expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });
});

describe('generation parameter and payload guards', () => {
    test.each([[123, request()], [model, {}], [model, { messages: [null] }]])('invalid request %p fails before token preparation', async (requestedModel, body) => {
        const backend = service();
        await expect(collect(backend.generateContentStream(requestedModel, body))).rejects.toMatchObject({ status: 400, skipErrorCount: true });
        expect(backend._prepareAccessTokenForRequest).not.toHaveBeenCalled();
        expect(backend._requestWithBuilderEndpointRouting).not.toHaveBeenCalled();
    });
    test('explicit zero top_p is preserved', () => { expect(buildKiroInferenceConfig({ top_p: 0 })).toEqual({ topP: 0 }); });
    test('explicit zero temperature is preserved', () => { expect(buildKiroInferenceConfig({ max_tokens: 123, temperature: 0, top_p: 0.5 })).toEqual({ maxTokens: 123, temperature: 0, topP: 0.5 }); });
    test.each([{ max_tokens: 0 }, { max_tokens: 1.1 }, { temperature: -1 }, { temperature: 2 }, { top_p: -1 }, { top_p: Infinity }])('invalid %p is a client error, not a credential failure', body => {
        try { buildKiroInferenceConfig(body); throw new Error('Expected rejection'); } catch (error) { expect(error).toMatchObject({ status: 400, skipErrorCount: true }); }
    });
    test('inference configuration can be explicitly disabled for an unsupported endpoint', () => { expect(buildKiroInferenceConfig({ max_tokens: 123 }, false)).toBeUndefined(); });
    test('the actual request builder includes inference fields and enforces the final byte limit', async () => {
        const backend = service(); backend.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
        const built = await backend.buildCodewhispererRequest(request().messages, model, null, null, null, null, null, { max_tokens: 123, temperature: 0 });
        expect(built.inferenceConfig).toEqual({ maxTokens: 123, temperature: 0 });
        backend.config.KIRO_MAX_PAYLOAD_BYTES = 100;
        await expect(backend.buildCodewhispererRequest(request().messages, model)).rejects.toMatchObject({ status: 413 });
    });
    test('oversized current input is rejected, never silently shortened', () => {
        const payload = { conversationState: { currentMessage: { userInputMessage: { content: 'x'.repeat(1000) } } } };
        expect(() => guardKiroPayload(payload, { KIRO_MAX_PAYLOAD_BYTES: 100, KIRO_TRIM_HISTORY: true })).toThrow(/exceeds/);
        expect(payload.conversationState.currentMessage.userInputMessage.content).toHaveLength(1000);
    });
    test('history trimming is opt-in, preserves the active tool turn and leaves the source untouched', () => {
        const pair = text => [{ userInputMessage: { content: text } }, { assistantResponseMessage: { content: text } }];
        const history = [...pair('system'), ...pair('x'.repeat(1000)), ...pair('recent')];
        history.at(-1).assistantResponseMessage.toolUses = [{ toolUseId: 'active', name: 'read', input: {} }];
        const payload = { conversationState: { history, currentMessage: { userInputMessage: { content: 'latest', userInputMessageContext: { toolResults: [{ toolUseId: 'active', content: [{ text: 'result' }] }] } } } } };
        expect(() => guardKiroPayload(payload, { KIRO_MAX_PAYLOAD_BYTES: 1200 })).toThrow(/exceeds/);
        const trimmed = guardKiroPayload(payload, { KIRO_MAX_PAYLOAD_BYTES: 1200, KIRO_TRIM_HISTORY: true });
        expect(trimmed.conversationState.history).toHaveLength(4);
        expect(trimmed.conversationState.currentMessage.userInputMessage.content).toContain('latest');
        expect(trimmed.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0].toolUseId).toBe('active');
        expect(history).toHaveLength(6);
    });
});


describe('single-flight cold initialization', () => {
    test('concurrent initializers share credential loading instead of overwriting each other', async () => {
        const backend = service(); backend.isInitialized = false;
        let resolve; backend.loadCredentials = jest.fn(() => new Promise(done => { resolve = done; }));
        const first = backend.initialize(), second = backend.initialize();
        expect(backend.loadCredentials).toHaveBeenCalledTimes(1);
        resolve(); await Promise.all([first, second]); expect(backend.isInitialized).toBe(true);
    });
    test('a failed initialization can retry rather than poisoning the shared promise', async () => {
        const backend = service(); backend.isInitialized = false;
        backend.loadCredentials = jest.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(undefined);
        await expect(backend.initialize()).rejects.toThrow('temporary');
        await backend.initialize(); expect(backend.isInitialized).toBe(true); expect(backend.loadCredentials).toHaveBeenCalledTimes(2);
    });
});
