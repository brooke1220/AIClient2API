import { Readable } from 'node:stream';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import { KiroFrameBuffer } from '../src/providers/claude/kiro-frame-buffer.js';
import { crc32, decodeKiroFrames, kiroIntegrityError } from '../src/providers/claude/kiro-event-stream.js';
import { collect, frame, model, request, service, text, tool } from './helpers/kiro-safety-fixtures.js';

const split = (bytes, size) => {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.subarray(offset, offset + size));
    return chunks;
};

function decodeOutcome(chunks, incremental, limit) {
    const frames = [];
    let remaining = Buffer.alloc(0);
    const accumulator = new KiroFrameBuffer(limit);
    try {
        for (const chunk of chunks) {
            if (incremental) frames.push(...accumulator.push(chunk));
            else {
                const decoded = decodeKiroFrames(Buffer.concat([remaining, chunk]), limit);
                frames.push(...decoded.frames);
                remaining = decoded.remaining;
            }
        }
        if (incremental) accumulator.finish();
        else if (remaining.length) throw kiroIntegrityError('truncated trailing event frame');
        return { frames };
    } catch (error) {
        return { frames, error: { message: error.message, code: error.code, status: error.status,
            responseFailureLabel: error.responseFailureLabel, upstreamCode: error.upstreamCode,
            kiroErrorKind: error.kiroErrorKind, shouldSwitchCredential: error.shouldSwitchCredential,
            isRetryableUpstreamResponseFailure: error.isRetryableUpstreamResponseFailure } };
    }
}

function reseal(bytes) {
    bytes.writeUInt32BE(crc32(bytes.subarray(0, -4)), bytes.length - 4);
    return bytes;
}

function malformedFrames() {
    const prelude = text('x'); prelude[8] ^= 1;
    const length = text('x'); length.writeUInt32BE(15, 0); length.writeUInt32BE(crc32(length.subarray(0, 8)), 8);
    const headersLength = text('x'); headersLength.writeUInt32BE(headersLength.length, 4);
    headersLength.writeUInt32BE(crc32(headersLength.subarray(0, 8)), 8);
    const messageCrc = text('x'); messageCrc[messageCrc.length - 1] ^= 1;
    const utf8 = text('x'); utf8[utf8.indexOf(Buffer.from('"x"')) + 1] = 0xff;
    const json = text('x'); json[json.length - 5] = 0x5b;
    const headerType = text('x'); headerType[13 + headerType[12]] = 0xff;
    return [
        ['prelude CRC', prelude], ['frame length', length], ['headers length', headersLength],
        ['message CRC', messageCrc], ['UTF-8', reseal(utf8)], ['JSON', reseal(json)],
        ['header type', reseal(headerType)], ['payload type', frame('assistantResponseEvent', [])],
        ['upstream exception', frame(null, { message: 'failed' }, { ':message-type': 'exception', ':exception-type': 'InternalServerException' })],
        ['classified upstream exception', frame(null, { message: 'rejected' }, { ':message-type': 'exception', ':exception-type': 'ValidationException' })],
        ['message type', frame('assistantResponseEvent', { content: 'x' }, { ':message-type': 'unknown' })]
    ];
}

describe('incremental Kiro frame boundaries and strict failure order', () => {
    const sequence = () => Buffer.concat([text('中文🟢'), tool({ name: 'read', toolUseId: 'a', input: { path: 'x' }, stop: true }),
        frame('metadataEvent', { stopReason: 'end_turn' })]);

    test.each([1, 2, 3, 7, 11, 12, 13, 17, 64, 1024])('matches the strict decoder for %i-byte chunks', size => {
        const bytes = sequence();
        expect(decodeOutcome(split(bytes, size), true)).toEqual({ frames: decodeKiroFrames(bytes).frames });
    });

    test('accepts every two-chunk boundary across several frames and multibyte payloads', () => {
        const bytes = sequence();
        const expected = { frames: decodeKiroFrames(bytes).frames };
        for (let cut = 0; cut <= bytes.length; cut++) {
            expect(decodeOutcome([bytes.subarray(0, cut), Buffer.alloc(0), bytes.subarray(cut)], true)).toEqual(expected);
        }
    });

    test('a transport chunk can contain more total bytes than the per-frame limit', () => {
        const one = text('a');
        expect(decodeOutcome([Buffer.concat([one, one, one])], true, one.length).frames).toHaveLength(3);
    });

    test.each(malformedFrames())('preserves %s validation and prior-chunk output for arbitrary splits', (_, invalid) => {
        const bytes = Buffer.concat([text('before'), invalid, text('after')]);
        for (const chunks of [[bytes], split(bytes, 1), split(bytes, 11), split(bytes, 29), [text('already emitted'), bytes]]) {
            expect(decodeOutcome(chunks, true)).toEqual(decodeOutcome(chunks, false));
        }
    });

    test('a bad trailing prelude prevents the valid frame in the same push from escaping', () => {
        const valid = text('same chunk');
        const corruptPrelude = text('bad').subarray(0, 12); corruptPrelude[8] ^= 1;
        const accumulator = new KiroFrameBuffer();
        expect(accumulator.push(valid.subarray(0, 9))).toEqual([]);
        expect(() => accumulator.push(Buffer.concat([valid.subarray(9), corruptPrelude]))).toThrow(/prelude CRC/);
    });

    test.each([1, 7, 11, 12, 20])('rejects EOF with %i bytes of an incomplete trailing frame', count => {
        const chunks = [text('prior'), text('truncated').subarray(0, count)];
        expect(decodeOutcome(chunks, true)).toEqual(decodeOutcome(chunks, false));
        expect(decodeOutcome(chunks, true).error.responseFailureLabel).toBe('truncated trailing event frame');
    });

    test.each([undefined, 0, 15, -1, NaN, Infinity, 'bad'])('keeps strict default-limit handling for %p', limit => {
        const chunks = split(text('accepted'), 3);
        expect(decodeOutcome(chunks, true, limit)).toEqual(decodeOutcome(chunks, false, limit));
    });

    test('rejects an oversized declared frame as soon as the split prelude completes, without trusting its allocation size', () => {
        const bytes = text('x'); bytes.writeUInt32BE(0xffffffff, 0); bytes.writeUInt32BE(crc32(bytes.subarray(0, 8)), 8);
        const accumulator = new KiroFrameBuffer(1024);
        const allocation = jest.spyOn(Buffer, 'allocUnsafe');
        try {
            expect(accumulator.push(bytes.subarray(0, 11))).toEqual([]);
            expect(() => accumulator.push(bytes.subarray(11, 12))).toThrow(/frame length/);
            expect(allocation.mock.calls.every(([size]) => size <= 12)).toBe(true);
        } finally { allocation.mockRestore(); }
    });
});

describe('frame accumulation copy and allocation budgets', () => {
    test('decodes complete frames directly without copying or allocating an accumulation buffer', () => {
        const bytes = Buffer.concat([text('one'), text('two')]);
        const accumulator = new KiroFrameBuffer();
        const copy = jest.spyOn(Buffer.prototype, 'copy');
        const allocation = jest.spyOn(Buffer, 'allocUnsafe');
        try {
            expect(accumulator.push(bytes)).toHaveLength(2);
            accumulator.finish();
            expect(copy).not.toHaveBeenCalled();
            expect(allocation).not.toHaveBeenCalled();
        } finally { copy.mockRestore(); allocation.mockRestore(); }
    });

    test.each([[64 * 1024, 1], [1024 * 1024, 97]])('copies a %i-byte payload in %i-byte chunks within a linear byte budget', (size, chunkSize) => {
        const payload = 'x'.repeat(size);
        const bytes = text(payload);
        const accumulator = new KiroFrameBuffer(bytes.length);
        const copy = jest.spyOn(Buffer.prototype, 'copy');
        const allocation = jest.spyOn(Buffer, 'allocUnsafe');
        let decoded;
        try {
            for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                const frames = accumulator.push(bytes.subarray(offset, offset + chunkSize));
                if (frames.length) decoded = frames[0];
            }
            accumulator.finish();
            expect(decoded.data.content).toBe(payload);
            expect(accumulator.length).toBe(0);
            const copiedBytes = copy.mock.calls.reduce((total, [, , start, end]) => total + end - start, 0);
            expect(copiedBytes).toBeLessThanOrEqual(bytes.length * 3);
            expect(allocation.mock.calls.every(([capacity]) => capacity <= bytes.length)).toBe(true);
            expect(allocation.mock.calls.length).toBeLessThanOrEqual(Math.ceil(Math.log2(bytes.length / 12)) + 1);
        } finally { copy.mockRestore(); allocation.mockRestore(); }
    });
});

describe('public Kiro stream integration', () => {
    test('streams split frames through the event mapper and preserves text and usage', async () => {
        const bytes = Buffer.concat([text('首字🟢'), text('suffix'), frame('metadataEvent', { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4 } })]);
        const backend = service(split(bytes, 7));
        const events = await collect(backend.generateContentStream(model, request()));
        expect(events.filter(event => event.delta?.text).map(event => event.delta.text).join('')).toBe('首字🟢suffix');
        expect(events.find(event => event.type === 'message_delta')).toMatchObject({ usage: { input_tokens: 3, output_tokens: 4 } });
        expect(events.at(-1)).toEqual({ type: 'message_stop' });
    });

    test('wire errors in a later frame still precede mapping an earlier invalid content field', async () => {
        const invalidContent = frame('assistantResponseEvent', { content: 42 });
        const badCrc = text('bad'); badCrc[badCrc.length - 1] ^= 1;
        const backend = service();
        backend._requestWithBuilderEndpointRouting.mockResolvedValue({ data: Readable.from([Buffer.concat([invalidContent, badCrc])]) });
        await expect(collect(backend.generateContentStream(model, request()))).rejects.toMatchObject({ responseFailureLabel: 'message CRC mismatch' });
    });
});
