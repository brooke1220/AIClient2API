import { Readable } from 'node:stream';
import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { KIRO_TRUNCATION_NOTICE } from '../src/providers/claude/kiro-truncation-recovery.js';
import { collect, frame, model, request, service, text, openStream, bounded, tick } from './helpers/kiro-safety-fixtures.js';

const followup = () => ({ messages: [...request().messages, { role: 'assistant', content: 'unfinished' }, { role: 'user', content: 'continue' }] });
async function nextPrompt(backend) {
    const body = followup();
    const payload = await backend.buildCodewhispererRequest(body.messages, model, null, null, null, null, null, body);
    return payload.conversationState.currentMessage.userInputMessage.content;
}

describe('buffered Kiro stream lifecycle and truncation recovery', () => {
    test('holds output until completion and corrects the initial input token count', async () => {
        const upstream = openStream();
        const backend = service();
        backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
        const stream = backend.generateContentStreamBuffered(model, request());
        let delivered = false;
        const pending = stream.next().then(value => { delivered = true; return value; });
        try {
            upstream.push(text('unfinished'));
            await tick();
            expect(delivered).toBe(false);
            upstream.push(frame('metadataEvent', { stopReason: 'max_tokens', usage: { inputTokens: 10, outputTokens: 4 } }));
            upstream.push(null);
            const first = await bounded(pending);
            expect(first.value).toMatchObject({ type: 'message_start', message: { usage: { input_tokens: 10 } } });
            const rest = await collect(stream);
            expect(rest.filter(event => event.delta?.text).map(event => event.delta.text).join('')).toBe('unfinished');
            expect(rest.find(event => event.type === 'message_delta')).toMatchObject({ delta: { stop_reason: 'max_tokens' }, usage: { input_tokens: 10, output_tokens: 4 } });
            expect(rest.at(-1)).toEqual({ type: 'message_stop' });
        } finally {
            upstream.destroy();
            await pending.catch(() => {});
            await stream.return();
        }
    });

    test('records a truncation notice for the matching next turn', async () => {
        const backend = service([text('unfinished'), frame('metadataEvent', { stopReason: 'max_tokens' })]);
        backend.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
        await collect(backend.generateContentStreamBuffered(model, request()));
        expect(await nextPrompt(backend)).toBe(`continue\n\n${KIRO_TRUNCATION_NOTICE}`);
    });

    test.each(['generateContentStream', 'generateContentStreamBuffered'])('a successful buffered retry clears a notice recorded by %s', async method => {
        const backend = service();
        backend.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
        let attempt = 0;
        backend._requestWithBuilderEndpointRouting.mockImplementation(async () => ({ data: Readable.from([
            text('unfinished'), frame('metadataEvent', { stopReason: attempt++ === 0 ? 'max_tokens' : 'end_turn' })
        ]) }));
        await collect(backend[method](model, request()));
        expect(await nextPrompt(backend)).toContain(KIRO_TRUNCATION_NOTICE);
        await collect(backend.generateContentStreamBuffered(model, request()));
        expect(await nextPrompt(backend)).toBe('continue');
    });

    test('incomplete upstream output fails without recording a truncation notice', async () => {
        const backend = service([text('unfinished'), text('lost').subarray(0, -1)]);
        backend.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
        await expect(collect(backend.generateContentStreamBuffered(model, request()))).rejects.toMatchObject({ code: 'KIRO_STREAM_INTEGRITY' });
        expect(await nextPrompt(backend)).toBe('continue');
    });

    test('disabled recovery still buffers output without creating a recovery record', async () => {
        const backend = service([text('unfinished'), frame('metadataEvent', { stopReason: 'max_tokens' })], { KIRO_TRUNCATION_RECOVERY: false });
        await collect(backend.generateContentStreamBuffered(model, request()));
        expect(backend._truncationRecovery).toBeUndefined();
    });

    test('cancellation during buffering closes upstream and records no completion', async () => {
        const upstream = openStream();
        const backend = service();
        backend.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
        backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: upstream });
        const controller = new AbortController();
        const operation = collect(backend.generateContentStreamBuffered(model, request(), { signal: controller.signal }));
        const rejection = expect(bounded(operation)).rejects.toThrow(/abort|premature close/i);
        upstream.push(text('unfinished'));
        await tick();
        controller.abort();
        await rejection;
        expect(upstream.destroyed).toBe(true);
        expect(await nextPrompt(backend)).toBe('continue');
    });
});
