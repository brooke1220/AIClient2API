import { Readable } from 'node:stream';
import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { kiroCacheMeter } from '../src/providers/claude/kiro-cache-meter.js';
import { buildKiroCacheProfile } from '../src/providers/claude/kiro-cache-profile.js';
import { KIRO_USAGE_DETAILS } from '../src/providers/claude/kiro-cache-usage.js';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { extractNormalizedUsage, mergeNormalizedUsage } from '../src/utils/usage-normalizer.js';
import logger from '../src/utils/logger.js';
import { collect, frame, model, service, text, tick, openStream, bounded } from './helpers/kiro-safety-fixtures.js';

const sourceText = 'stable prompt with enough content '.repeat(100);
const request = () => ({ metadata: { session_id: 'cache-integration-session' }, messages: [{ role: 'user', content: [
    { type: 'text', text: sourceText, cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'fresh tail' }
] }] });
const usageOf = events => events.find(event => event.type === 'message_delta').usage;
function backend(config = {}) {
    const value = service([], { KIRO_PROMPT_CACHE_MODE: 'estimate', KIRO_TRUNCATION_RECOVERY: false,
        KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: { 'claude-sonnet-4.5': 1, 'claude-sonnet-4-5': 1 }, ...config });
    value.uuid = 'account-a';
    value.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
    value._requestWithBuilderEndpointRouting = KiroApiService.prototype._requestWithBuilderEndpointRouting;
    value._assertKiroAccountAvailable = jest.fn();
    value.estimateInputTokens = () => 12000;
    value.axiosInstance = { request: jest.fn(async () => ({ data: Readable.from([text('answer'),
        frame('metadataEvent', { stopReason: 'end_turn', usage: { inputTokens: 12000, outputTokens: 6 } })]) })) };
    return value;
}

beforeEach(() => { kiroCacheMeter.clear(); jest.clearAllMocks(); });

describe('Kiro cache accounting through request, stream and protocol conversion', () => {
    test.each(['generateContentStream', 'generateContentStreamBuffered', 'generateContent'])('%s writes then reads the same actual prefix', async method => {
        const value = backend();
        const run = async () => method === 'generateContent' ? (await value[method](model, request())).usage
            : usageOf(await collect(value[method](model, request())));
        const cold = await run(), warm = await run();
        expect(cold.cache_creation_input_tokens).toBeGreaterThan(0);
        expect(cold.cache_read_input_tokens).toBe(0);
        expect(warm.cache_read_input_tokens).toBe(cold.cache_creation_input_tokens);
        expect(warm.cache_creation_input_tokens).toBe(0);
        for (const usage of [cold, warm]) {
            expect(usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens).toBe(12000);
            expect(usage[KIRO_USAGE_DETAILS].sources.cache_read_input_tokens).toBe('estimated');
        }
        const sent = JSON.stringify(value.axiosInstance.request.mock.calls[0][0].data);
        expect(sent).not.toMatch(/_kiro|cacheAccounting|session_id|cache_control/);
    });
    test('live starts at zero, buffered starts at final usage, all consumers receive the same total', async () => {
        const value = backend();
        await collect(value.generateContentStream(model, request()));
        const events = await collect(value.generateContentStream(model, request()));
        expect(events[0].message.usage.input_tokens).toBe(0);
        const final = usageOf(events);
        const stats = events.reduce((usage, event) => mergeNormalizedUsage(usage, extractNormalizedUsage(event)), undefined);
        expect(stats).toMatchObject({ promptTokens: 12000, completionTokens: 6, totalTokens: 12006,
            cachedTokens: final.cache_read_input_tokens, cacheCreationTokens: 0, cacheSource: 'estimated' });
        const buffered = await collect(value.generateContentStreamBuffered(model, request()));
        expect(buffered[0].message.usage).toMatchObject({ ...usageOf(buffered), output_tokens: 0 });
        const response = await value.generateContent(model, request());
        const converter = new ClaudeConverter();
        for (const protocol of ['openai', 'openaiResponses']) {
            const converted = converter.convertResponse(response, protocol, model);
            const usage = converted.usage;
            expect(usage.prompt_tokens ?? usage.input_tokens).toBe(12000);
            expect(usage.total_tokens).toBe(12006);
            expect(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens).toBe(final.cache_read_input_tokens);
            expect(extractNormalizedUsage(response, converted).cacheSource).toBe('estimated');
        }
    });
    test('observe logs hypothetical usage, while off never records local prefixes', async () => {
        const value = backend({ KIRO_PROMPT_CACHE_MODE: 'observe' });
        const response = await value.generateContent(model, request());
        expect(response.usage).toMatchObject({ input_tokens: 12000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
        expect(logger.info.mock.calls.some(([line]) => line.startsWith('[Kiro Usage]') && line.includes('observed'))).toBe(true);
        expect(kiroCacheMeter.entries.size).toBeGreaterThan(0);
        kiroCacheMeter.clear(); value.config.KIRO_PROMPT_CACHE_MODE = 'off';
        await value.generateContent(model, request());
        expect(kiroCacheMeter.entries.size).toBe(0);
    });
    test('complete provider cache zero wins over a warm local prefix', async () => {
        const value = backend(); await value.generateContent(model, request());
        value.axiosInstance.request.mockImplementation(async () => ({ data: Readable.from([text('answer'), frame('metadataEvent', {
            tokenUsage: { uncachedInputTokens: 12000, outputTokens: 2, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
        })]) }));
        const result = await value.generateContent(model, request());
        expect(result.usage).toMatchObject({ input_tokens: 12000, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
        expect(result.usage[KIRO_USAGE_DETAILS].totalSource).toBe('provider');
    });
    test.each([true, false])('partial native uncached input preserves the total budget (provider total: %s)', async reportTotal => {
        const value = backend();
        value.axiosInstance.request.mockImplementation(async () => ({ data: Readable.from([text('answer'), frame('metadataEvent', {
            ...(reportTotal ? { usage: { inputTokens: 12000 } } : {}),
            tokenUsage: { uncachedInputTokens: 3000, outputTokens: 2, cacheReadInputTokens: 0 }
        })]) }));
        const result = await value.generateContent(model, request());
        expect(result.usage.input_tokens).toBe(3000);
        expect(result.usage.cache_read_input_tokens).toBe(0);
        expect(result.usage.cache_creation_input_tokens).toBeGreaterThan(0);
        expect(result.usage[KIRO_USAGE_DETAILS].sources.cache_creation_input_tokens).toBe(reportTotal ? 'provider' : 'estimated');
        expect(result.usage[KIRO_USAGE_DETAILS].totalSource).toBe(reportTotal ? 'provider' : 'mixed');
        expect(result.usage[KIRO_USAGE_DETAILS].totalInputTokens).toBeLessThanOrEqual(12000);
    });
    test.each(['generateContentStream', 'generateContentStreamBuffered', 'generateContent'])('%s conserves a provider total with a small cache prefix and a large fresh tail', async method => {
        const value = backend();
        const input = request();
        input.messages[0].content[0].text = 'small marked prefix';
        input.messages[0].content[1].text = 'large fresh content '.repeat(2000);
        value.axiosInstance.request.mockImplementation(async () => ({ data: Readable.from([text('answer'), frame('metadataEvent', {
            usage: { inputTokens: 12000 }, tokenUsage: { uncachedInputTokens: 3000, outputTokens: 2, cacheReadInputTokens: 0 }
        })]) }));
        const response = method === 'generateContent' ? await value[method](model, input)
            : { usage: usageOf(await collect(value[method](model, input))) };
        expect(response.usage).toMatchObject({ input_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 9000 });
        expect(extractNormalizedUsage(response)).toMatchObject({ promptTokens: 12000, totalTokens: 12002, cacheSource: 'provider' });
        const converter = new ClaudeConverter();
        for (const protocol of ['openai', 'openaiResponses']) {
            const converted = converter.convertResponse({ ...response, content: [], model }, protocol, model);
            expect(converted.usage.prompt_tokens ?? converted.usage.input_tokens).toBe(12000);
            expect(converted.usage.total_tokens).toBe(12002);
        }
    });
    test('tool changes and account changes invalidate a previously warm prefix', async () => {
        const value = backend(); await value.generateContent(model, request());
        const changed = request(); changed.tools = [{ name: 'read', description: 'read a file', input_schema: { type: 'object' } }];
        expect((await value.generateContent(model, changed)).usage.cache_read_input_tokens).toBe(0);
        const other = backend(); other.uuid = 'account-b';
        expect((await other.generateContent(model, request())).usage.cache_read_input_tokens).toBe(0);
    });
    test('failed attempts, invalid streams and rejected buffering never warm the ledger', async () => {
        const value = backend();
        value.axiosInstance.request.mockResolvedValueOnce({ data: Readable.from([text('incomplete'), text('broken').subarray(0, -1)]) });
        await expect(value.generateContent(model, request())).rejects.toMatchObject({ code: 'KIRO_STREAM_INTEGRITY' });
        expect(kiroCacheMeter.entries.size).toBe(0);
        value.config.KIRO_MAX_BUFFERED_RESPONSE_BYTES = 1;
        await expect(collect(value.generateContentStreamBuffered(model, request()))).rejects.toMatchObject({ code: 'KIRO_BUFFER_LIMIT' });
        expect(kiroCacheMeter.entries.size).toBe(0);
        delete value.config.KIRO_MAX_BUFFERED_RESPONSE_BYTES;
        expect((await value.generateContent(model, request())).usage.cache_read_input_tokens).toBe(0);
    });
    test('aborting live output closes the stream without committing', async () => {
        const value = backend(), upstream = openStream(), controller = new AbortController();
        value.axiosInstance.request.mockResolvedValue({ data: upstream });
        const stream = value.generateContentStream(model, request(), { signal: controller.signal });
        const first = stream.next();
        await tick(); upstream.push(text('partial'));
        await bounded(first); controller.abort(); await stream.return();
        expect(upstream.destroyed).toBe(true);
        expect(kiroCacheMeter.entries.size).toBe(0);
    });
    test('network retry does not publish a failed cold attempt as a hit', async () => {
        const value = backend();
        const error = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        value.axiosInstance.request.mockRejectedValueOnce(error);
        const result = await value.generateContent(model, request());
        expect(value.axiosInstance.request).toHaveBeenCalledTimes(2);
        expect(result.usage.cache_read_input_tokens).toBe(0);
        expect(result.usage.cache_creation_input_tokens).toBeGreaterThan(0);
    });
    test('the history strategy counts stable history but leaves current user input uncached', async () => {
        const value = backend();
        const body = { metadata: request().metadata, messages: [
            { role: 'user', content: sourceText }, { role: 'assistant', content: 'history answer' }, { role: 'user', content: 'new question' }
        ] };
        const cold = await value.generateContent(model, structuredClone(body));
        const warm = await value.generateContent(model, structuredClone(body));
        expect(cold.usage.cache_creation_input_tokens).toBeGreaterThan(0);
        expect(warm.usage.cache_read_input_tokens).toBeGreaterThan(0);
        expect(warm.usage.input_tokens).toBeGreaterThan(0);
        expect(warm.usage[KIRO_USAGE_DETAILS].policy).toBe('history');
    });
    test('an explicit current prefix stays reusable when it moves into growing history', async () => {
        const value = backend();
        const body = request();
        const first = await value.generateContent(model, structuredClone(body));
        body.messages.push({ role: 'assistant', content: 'answer' }, { role: 'user', content: 'next question' });
        const grown = await value.generateContent(model, structuredClone(body));
        expect(first.usage.cache_creation_input_tokens).toBeGreaterThan(0);
        expect(grown.usage.cache_read_input_tokens).toBeGreaterThan(0);
        expect(grown.usage.cache_creation_input_tokens).toBe(0);
        expect(grown.usage[KIRO_USAGE_DETAILS].reason).toBeNull();
    });
    test('endpoint and downstream session changes cannot reuse an account prefix', async () => {
        const value = backend(); await value.generateContent(model, request());
        const otherSession = request(); otherSession.metadata.session_id = 'another-client-session';
        expect((await value.generateContent(model, otherSession)).usage.cache_read_input_tokens).toBe(0);
        const otherEndpoint = backend(); otherEndpoint.baseUrl = 'https://other.mock.invalid/generateAssistantResponse';
        expect((await otherEndpoint.generateContent(model, request())).usage.cache_read_input_tokens).toBe(0);
    });
    test('trimmed or rewritten marked entries are never widened into surviving history', async () => {
        const value = backend({ KIRO_TRIM_HISTORY: true, KIRO_MAX_PAYLOAD_BYTES: 2400 });
        const messages = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'first answer' },
            { role: 'user', content: [{ type: 'text', text: 'removed '.repeat(300), cache_control: { type: 'ephemeral' } }] },
            { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'keep' },
            { role: 'assistant', content: 'keep answer' }, { role: 'user', content: 'current' }];
        const payload = await value.buildCodewhispererRequest(messages, model, null, null, null, null, null, { messages });
        const p = buildKiroCacheProfile(payload, payload._kiroCacheSourceInfo, value.config);
        expect(JSON.stringify(payload)).not.toContain('removed removed');
        expect(p).toMatchObject({ policy: 'explicit', reason: 'unmapped_breakpoint', breakpoints: [] });
    });
});
