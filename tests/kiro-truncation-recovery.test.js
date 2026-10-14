import { jest } from '@jest/globals';
import { Readable } from 'node:stream';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { KiroTruncationRecovery, KIRO_TRUNCATION_NOTICE } from '../src/providers/claude/kiro-truncation-recovery.js';
import { frame, text, tool, request, model, service, collect } from './helpers/kiro-safety-fixtures.js';

const delta = value => ({ type: 'content_block_delta', delta: { type: 'text_delta', text: value } });
function remember(recovery, body = request(), chunks = ['unfinished'], stop = 'max_tokens', options = {}) {
    const observation = recovery.observe(model, body);
    for (const chunk of chunks) observation.accept(delta(chunk));
    if (options.tools) observation.accept({ type: 'content_block_start', content_block: { type: 'tool_use' } });
    observation.accept({ type: 'message_delta', delta: { stop_reason: stop } });
    if (options.complete !== false) observation.accept({ type: 'message_stop' });
    return observation;
}
const followup = (body = request(), content = 'unfinished') => ({ ...body, messages: [...body.messages, { role: 'assistant', content }, { role: 'user', content: 'continue' }] });

beforeEach(() => jest.clearAllMocks());

describe('bounded, evidence-only truncation digests', () => {
    test('no fabricated notice without an observed max_tokens completion', () => {
        expect(new KiroTruncationRecovery().getNotice(model, followup())).toBe('');
    });
    test('ordinary responses do not fingerprint large request contexts on the first-token path', () => {
        const body = request();
        Object.defineProperty(body, 'system', { get: () => { throw new Error('must not fingerprint an ordinary response'); } });
        expect(() => remember(new KiroTruncationRecovery(), body, ['answer'], 'end_turn')).not.toThrow();
    });
    test('invalid internal resource options cannot disable capacity or TTL bounds', () => {
        const value = new KiroTruncationRecovery({ limit: -1, ttlMs: NaN, now: null });
        expect(value.limit).toBe(64);
        expect(value.ttlMs).toBe(600000);
        expect(typeof value.now).toBe('function');
    });
    test('exact observed history receives a retry-stable notice without storing response text', () => {
        const recovery = new KiroTruncationRecovery();
        remember(recovery);
        expect(recovery.getNotice(model, followup())).toBe(KIRO_TRUNCATION_NOTICE);
        expect(recovery.getNotice(model, followup())).toBe(KIRO_TRUNCATION_NOTICE);
        for (const [key, value] of recovery.entries) { expect(key).toMatch(/^[a-f0-9]{64}:[a-f0-9]{64}$/); expect(typeof value).toBe('number'); }
    });
    test.each(['end_turn', 'stop_sequence', 'tool_use', null])('%s never creates a truncation record', stop => {
        const recovery = new KiroTruncationRecovery(); remember(recovery, request(), ['unfinished'], stop);
        expect(recovery.getNotice(model, followup())).toBe('');
    });
    test.each([{ complete: false }, { tools: true }])('unfinished streams and tool-bearing output %p are never replayed', options => {
        const recovery = new KiroTruncationRecovery(); remember(recovery, request(), ['unfinished'], 'max_tokens', options);
        expect(recovery.entries.size).toBe(0);
    });
    test('thinking-only whitespace fallback is not evidence of text truncation', () => {
        const recovery = new KiroTruncationRecovery(); remember(recovery, request(), [' ']);
        expect(recovery.entries.size).toBe(0);
    });
    test.each(['end_turn', 'stop_sequence'])('a newer matching %s completion invalidates an old truncation marker', stop => {
        const recovery = new KiroTruncationRecovery();
        remember(recovery);
        expect(recovery.getNotice(model, followup())).toBe(KIRO_TRUNCATION_NOTICE);
        remember(recovery, request(), ['unfinished'], stop);
        expect(recovery.getNotice(model, followup())).toBe('');
        expect(recovery.entries.size).toBe(0);
    });
    test('clearing a matching successful retry preserves other sessions and other output digests', () => {
        const recovery = new KiroTruncationRecovery();
        const other = { ...request(), metadata: { user_id: 'other-session' } };
        remember(recovery); remember(recovery, other); remember(recovery, request(), ['different output']);
        remember(recovery, request(), ['unfinished'], 'end_turn');
        expect(recovery.getNotice(model, followup())).toBe('');
        expect(recovery.getNotice(model, followup(other))).toBe(KIRO_TRUNCATION_NOTICE);
        expect(recovery.getNotice(model, followup(request(), 'different output'))).toBe(KIRO_TRUNCATION_NOTICE);
        expect(recovery.entries.size).toBe(2);
    });
    test('a retry without a complete terminal event cannot erase real truncation evidence', () => {
        const recovery = new KiroTruncationRecovery(); remember(recovery);
        remember(recovery, request(), ['unfinished'], 'end_turn', { complete: false });
        expect(recovery.getNotice(model, followup())).toBe(KIRO_TRUNCATION_NOTICE);
        remember(recovery, request(), ['unfinished'], null);
        expect(recovery.getNotice(model, followup())).toBe(KIRO_TRUNCATION_NOTICE);
    });
    test('UTF-8 and split surrogate fragments match the full assistant string', () => {
        const recovery = new KiroTruncationRecovery(); remember(recovery, request(), ['中', '\ud83d', '\udfe2', '文']);
        expect(recovery.getNotice(model, followup(request(), '中🟢文'))).toBe(KIRO_TRUNCATION_NOTICE);
    });
    test.each([
        body => ({ ...body, system: 'different instructions' }),
        body => ({ ...body, user: 'different-user' }),
        body => ({ ...body, metadata: { user_id: 'different-session' } }),
        body => ({ ...body, tools: [{ name: 'other', description: 'different', input_schema: {} }] }),
        body => ({ ...body, messages: [{ role: 'user', content: 'different topic' }, ...body.messages.slice(1)] }),
        body => ({ ...body, messages: [body.messages[0], { role: 'assistant', content: 'different answer' }, body.messages[2]] })
    ])('different request context cannot reuse another history record', change => {
        const recovery = new KiroTruncationRecovery(); remember(recovery);
        expect(recovery.getNotice(model, change(followup()))).toBe('');
    });
    test('different models and service instances are isolated', () => {
        const recovery = new KiroTruncationRecovery(); remember(recovery);
        expect(recovery.getNotice('claude-opus-4.6', followup())).toBe('');
        expect(new KiroTruncationRecovery().getNotice(model, followup())).toBe('');
    });
    test('newer assistant turns prevent stale recovery advice', () => {
        const recovery = new KiroTruncationRecovery(); remember(recovery);
        const body = followup(); body.messages.push({ role: 'assistant', content: 'completed' }, { role: 'user', content: 'next task' });
        expect(recovery.getNotice(model, body)).toBe('');
    });
    test('cache metadata, thinking blocks and equivalent text block boundaries do not defeat matching', () => {
        const recovery = new KiroTruncationRecovery();
        const first = { system: [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }] }] };
        remember(recovery, first, ['un', 'finished']);
        const next = followup(request(), [{ type: 'thinking', thinking: 'not part of the fingerprint' }, { type: 'text', text: 'un' }, { type: 'text', text: 'finished' }]);
        next.system = 'rules';
        expect(recovery.getNotice(model, next)).toBe(KIRO_TRUNCATION_NOTICE);
    });
    test('TTL expiration and bounded capacity discard old digests', () => {
        let now = 0; const recovery = new KiroTruncationRecovery({ limit: 2, ttlMs: 100, now: () => now });
        remember(recovery, request(), ['first']); remember(recovery, request(), ['second']); remember(recovery, request(), ['third']);
        expect(recovery.entries.size).toBe(2);
        expect(recovery.getNotice(model, followup(request(), 'first'))).toBe('');
        expect(recovery.getNotice(model, followup(request(), 'third'))).toBe(KIRO_TRUNCATION_NOTICE);
        now = 100;
        expect(recovery.getNotice(model, followup(request(), 'third'))).toBe('');
        expect(recovery.entries.size).toBe(0);
    });
});

describe('actual streaming and unary request integration', () => {
    test.each(['stream', 'unary'])('%s: explicit truncation leaves the response unchanged and annotates only the matching next turn', async mode => {
        const backend = service([text('unfinished'), frame('metadataEvent', { stopReason: 'max_tokens' })]);
        backend.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
        if (mode === 'stream') {
            const events = await collect(backend.generateContentStream(model, request()));
            expect(events.find(event => event.type === 'message_delta').delta.stop_reason).toBe('max_tokens');
            expect(events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text).join('')).toBe('unfinished');
        } else {
            const response = await backend.generateContent(model, request());
            expect(response.content).toEqual([{ type: 'text', text: 'unfinished' }]);
            expect(response.stop_reason).toBe('max_tokens');
        }
        const next = followup(); const original = JSON.stringify(next);
        const payload = await backend.buildCodewhispererRequest(next.messages, model, null, null, null, null, null, next);
        expect(payload.conversationState.currentMessage.userInputMessage.content).toBe(`continue\n\n${KIRO_TRUNCATION_NOTICE}`);
        expect(payload.conversationState.history).toHaveLength(2);
        expect(JSON.stringify(next)).toBe(original);
        const normal = await backend.buildCodewhispererRequest(request().messages, model);
        expect(normal.conversationState.currentMessage.userInputMessage.content).toBe('hello');
    });
    test.each(['stream', 'unary'])('%s: successful retry clears a previously observed max_tokens notice', async mode => {
        const backend = service();
        backend.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
        let attempt = 0;
        backend._requestWithBuilderEndpointRouting.mockImplementation(async () => ({ data: Readable.from([
            text('unfinished'), frame('metadataEvent', { stopReason: attempt++ === 0 ? 'max_tokens' : 'end_turn' })
        ]) }));
        const run = () => mode === 'stream' ? collect(backend.generateContentStream(model, request())) : backend.generateContent(model, request());
        await run();
        const first = await backend.buildCodewhispererRequest(followup().messages, model);
        expect(first.conversationState.currentMessage.userInputMessage.content).toContain(KIRO_TRUNCATION_NOTICE);
        await run();
        const latest = await backend.buildCodewhispererRequest(followup().messages, model);
        expect(latest.conversationState.currentMessage.userInputMessage.content).toBe('continue');
    });
    test('disabled recovery tracks nothing and injects nothing', async () => {
        const backend = service([text('unfinished'), frame('metadataEvent', { stopReason: 'max_tokens' })], { KIRO_TRUNCATION_RECOVERY: false });
        backend.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
        await backend.generateContent(model, request());
        expect(backend._truncationRecovery).toBeUndefined();
        const payload = await backend.buildCodewhispererRequest(followup().messages, model);
        expect(payload.conversationState.currentMessage.userInputMessage.content).toBe('continue');
    });
    test('a normal EOF without explicit max_tokens is not guessed to be truncation', async () => {
        const backend = service([text('unfinished')]); await backend.generateContent(model, request());
        expect(backend._truncationRecovery.entries.size).toBe(0);
    });
    test('incomplete event frames stay failed; no recovery record or successful tool call is manufactured', async () => {
        const backend = service([text('unfinished'), text('lost').subarray(0, -1)]);
        await expect(backend.generateContent(model, request())).rejects.toMatchObject({ status: 502, skipErrorCount: true, recoveryHint: expect.stringContaining('incomplete event frame') });
        expect(backend._truncationRecovery.entries.size).toBe(0);
    });
    test('incomplete tool JSON remains a hard failure, without repair or automatic execution', async () => {
        const backend = service([tool({ name: 'write_file', toolUseId: 't', input: '{"content":"unfinished', stop: true })]);
        await expect(backend.generateContent(model, { ...request(), tools: [{ name: 'write_file', description: 'Write file', input_schema: { type: 'object' } }] })).rejects.toMatchObject({ status: 502, skipErrorCount: true, recoveryHint: expect.stringContaining('No malformed tool call was emitted') });
        expect(backend._truncationRecovery.entries.size).toBe(0);
    });
    test('legacy partial JSON gets the same actionable failure, never an invented tool call', async () => {
        const backend = service([text('[Called write_file with args: {"content":"unfinished')]);
        await expect(backend.generateContent(model, { ...request(), tools: [{ name: 'write_file', description: 'Write file', input_schema: { type: 'object' } }] })).rejects.toMatchObject({ status: 502, skipErrorCount: true, recoveryHint: expect.stringContaining('No malformed tool call was emitted') });
        expect(backend._truncationRecovery.entries.size).toBe(0);
    });
    test('consumer cancellation does not record a response that never reached message_stop', async () => {
        const backend = service([text('unfinished'), frame('metadataEvent', { stopReason: 'max_tokens' })]);
        const stream = backend.generateContentStream(model, request());
        await stream.next(); await stream.next(); await stream.return();
        expect(backend._truncationRecovery.entries.size).toBe(0);
    });
});
