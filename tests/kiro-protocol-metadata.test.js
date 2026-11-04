import { Readable } from 'node:stream';
import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import { collect, frame, model, request, service, text, response } from './helpers/kiro-safety-fixtures.js';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { getRateLimitCooldownRecoveryTime, handleError } from '../src/utils/common.js';

const metadata = data => frame('metadataEvent', data);
const native = { uncachedInputTokens: 101, outputTokens: 23, cacheReadInputTokens: 300, cacheWriteInputTokens: 40 };
const usage = { input_tokens: 101, output_tokens: 23, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 };

describe('Kiro native protocol metadata', () => {
    test.each(['generateContentStream', 'generateContentStreamBuffered'])('%s uses the latest native snapshot, with cache counts', async method => {
        const backend = service([text('answer'), metadata({ tokenUsage: { ...native, outputTokens: 1 } }),
            metadata({ tokenUsage: native, stopReason: 'end_turn' }), metadata({ tokenUsage: { outputTokens: -1 } })]);
        const events = await collect(backend[method](model, request()));
        expect(events.find(e => e.type === 'message_delta').usage).toEqual(usage);
        if (method.endsWith('Buffered')) expect(events[0].message.usage).toMatchObject({ ...usage, output_tokens: 0 });
    });

    test('partial native snapshots retain known counts and estimated missing fields', async () => {
        const events = await collect(service([text('answer'), metadata({ tokenUsage: { cacheReadInputTokens: 30 } }),
            metadata({ tokenUsage: { outputTokens: 7 } })]).generateContentStream(model, request()));
        expect(events.find(e => e.type === 'message_delta').usage).toEqual({ input_tokens: 12, output_tokens: 7,
            cache_read_input_tokens: 30, cache_creation_input_tokens: 0 });
    });

    test('complete native counts avoid tokenizing the entire completed output again', async () => {
        const backend = service([text('answer'), metadata({ tokenUsage: native })]);
        backend.countTextTokens = jest.fn(() => { throw new Error('Unexpected full-output tokenization'); });
        expect((await backend.generateContent(model, request())).usage).toEqual(usage);
        expect(backend.countTextTokens).not.toHaveBeenCalled();
    });

    test('nullable optional reasoning fields do not corrupt a valid signed block', async () => {
        const result = await service([frame('reasoningContentEvent', { text: 'reason', signature: null, redactedContent: null }),
            frame('reasoningContentEvent', { text: null, signature: 'sig' }), text('answer')]).generateContent(model, request());
        expect(result.content[0]).toEqual({ type: 'thinking', thinking: 'reason', signature: 'sig' });
    });

    test('nonstream preserves native thinking signatures, redacted data, and usage', async () => {
        const result = await service([frame('reasoningContentEvent', { text: 'reason' }),
            frame('reasoningContentEvent', { signature: 'opaque-signature' }),
            frame('reasoningContentEvent', { redactedContent: 'opaque-redacted' }), text('answer'),
            metadata({ tokenUsage: native, stopReason: 'end_turn' })]).generateContent(model, request());
        expect(result.content).toEqual([{ type: 'thinking', thinking: 'reason', signature: 'opaque-signature' },
            { type: 'redacted_thinking', data: 'opaque-redacted' }, { type: 'text', text: 'answer' }]);
        expect(result.usage).toEqual(usage);
        const converted = new ClaudeConverter().convertResponse(result, 'openai');
        expect(converted.usage).toMatchObject({ prompt_tokens: 441, completion_tokens: 23, total_tokens: 464,
            prompt_tokens_details: { cached_tokens: 300 } });
    });

    test.each([{ prefix: [] }, { prefix: [frame('reasoningContentEvent', { text: 'reason', signature: 'sig' })] }])('content filtering yields a refusal without retrying', async ({ prefix }) => {
        const result = await service([...prefix, metadata({ stopReason: 'CONTENT_FILTERED',
            stopDetails: { refusal: { category: 'policy', explanation: 'Cannot answer' } } })]).generateContent(model, request());
        expect(result.stop_reason).toBe('refusal');
        expect(result.content.at(-1)).toEqual({ type: 'text', text: 'policy: Cannot answer' });
        expect(new ClaudeConverter().convertResponse(result, 'openai').choices[0].finish_reason).toBe('content_filter');
    });

    test('metering is a separate credit snapshot, accepts zero, and does not sum repeated totals', async () => {
        const result = await service([text('answer'), frame('meteringEvent', { usage: 0, unit: 'credit' }),
            frame('meteringEvent', { usage: 0.125, unit: 'credit' }),
            frame('meteringEvent', { usage: 0.125, unit: 'credit' }),
            frame('meteringEvent', { usage: -5, unit: 'credit' }), metadata({ tokenUsage: native })]).generateContent(model, request());
        expect(result.usage).toMatchObject({ ...usage, credit_usage: 0.125, credit_unit: 'credit' });
        const converter = new ClaudeConverter();
        for (const protocol of ['openai', 'openaiResponses']) {
            expect(converter.convertResponse(result, protocol).usage).toMatchObject({ credit_usage: 0.125, credit_unit: 'credit' });
            const events = await collect(service([text('answer'), metadata({ tokenUsage: native }),
                frame('meteringEvent', { usage: 0.125, unit: 'credit' })]).generateContentStream(model, request()));
            const chunks = events.flatMap(event => {
                const chunk = converter.convertStreamChunk(event, protocol, model, `metering-${protocol}`);
                return chunk ? Array.isArray(chunk) ? chunk : [chunk] : [];
            });
            const finalUsage = chunks.findLast(chunk => chunk.usage || chunk.response?.usage);
            expect(finalUsage.usage || finalUsage.response.usage).toMatchObject({ credit_usage: 0.125, credit_unit: 'credit' });
        }
    });

    test('a bounded buffered response fails before downstream output and closes upstream', async () => {
        const upstream = Readable.from([text('x'.repeat(1024))]);
        const backend = service([], { KIRO_MAX_BUFFERED_RESPONSE_BYTES: 800 });
        backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
        await expect(backend.generateContentStreamBuffered(model, request()).next()).rejects.toMatchObject({ code: 'KIRO_BUFFER_LIMIT', skipErrorCount: true });
        expect(upstream.destroyed).toBe(true);
    });
});

describe('explicit Kiro failures do not churn accounts', () => {
    test.each([
        [500, { reason: 'MODEL_TEMPORARILY_UNAVAILABLE' }, 503, 'KIRO_MODEL_UNAVAILABLE'],
        [500, { message: 'Invalid request: messages must alternate' }, 400, 'KIRO_REQUEST_INVALID'],
        [524, 'gateway timeout', 504, 'KIRO_GATEWAY_TIMEOUT'],
        [429, { reason: 'CAPACITY_EXCEEDED' }, 429, 'KIRO_CAPACITY_THROTTLED'],
        [400, { reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD' }, 413, 'KIRO_PAYLOAD_TOO_LARGE']
    ])('classifies %s %j before retry/failover', async (status, body, expected, code) => {
        const backend = service();
        const error = Object.assign(new Error('Upstream rejected request'), { response: {
            status, data: Readable.from([JSON.stringify(body)]), headers: { 'retry-after': '17' }
        } });
        backend._requestWithBuilderEndpointRouting.mockRejectedValue(error);
        await expect(collect(backend.generateContentStream(model, request()))).rejects.toMatchObject({
            status: expected, code, skipErrorCount: true, shouldSwitchCredential: false
        });
        expect(backend._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
        const res = response();
        handleError(res, error, null, 'claude');
        expect(res.writeHead).toHaveBeenCalledWith(expected, expect.objectContaining({ 'Retry-After': '17' }));
    });

    test('an explicit account throttle schedules cooldown even when generic cooldown is disabled', async () => {
        const backend = service();
        const error = Object.assign(new Error('limited'), { response: { status: 429,
            data: { reason: 'SERVICE_REQUEST_RATE_EXCEEDED' }, headers: { 'retry-after': '12' } } });
        backend._requestWithBuilderEndpointRouting.mockRejectedValue(error);
        await expect(collect(backend.generateContentStream(model, request()))).rejects.toMatchObject({ kiroAccountRateLimited: true, shouldSwitchCredential: true });
        expect(getRateLimitCooldownRecoveryTime(error, { RATE_LIMIT_COOLDOWN_ENABLED: false }, 1000, 'claude-kiro-oauth').getTime()).toBe(13000);
    });

    test('capacity throttling never quarantines an account, even with generic cooldown enabled', async () => {
        const backend = service();
        const error = Object.assign(new Error('capacity'), { response: { status: 429,
            data: { reason: 'INSUFFICIENT_MODEL_CAPACITY' }, headers: { 'retry-after': '12' } } });
        backend._requestWithBuilderEndpointRouting.mockRejectedValue(error);
        await expect(collect(backend.generateContentStream(model, request()))).rejects.toMatchObject({ shouldSwitchCredential: false });
        expect(getRateLimitCooldownRecoveryTime(error, { RATE_LIMIT_COOLDOWN_ENABLED: true }, 1000, 'claude-kiro-oauth')).toBeNull();
    });
});
