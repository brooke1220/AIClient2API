import { decodeKiroFrames, kiroIntegrityError } from './kiro-event-stream.js';

/**
 * Retain only the unfinished AWS frame between transport chunks. Complete
 * frames stay zero-copy; a split frame grows geometrically, so small chunks
 * cannot repeatedly copy its entire prefix. The strict decoder owns all wire
 * validation, including checking the prelude before trusting its frame length.
 */
export class KiroFrameBuffer {
    constructor(maxFrameBytes) {
        this.maxFrameBytes = maxFrameBytes;
        this._buffer = null;
        this._length = 0;
        this._frameLength = 0;
    }

    get length() { return this._length; }

    _append(bytes, limit) {
        if (!bytes.length) return;
        const required = this._length + bytes.length;
        if (!this._buffer || this._buffer.length < required) {
            let capacity = this._buffer?.length || 12;
            while (capacity < required) capacity = Math.min(limit, capacity * 2);
            const next = Buffer.allocUnsafe(capacity);
            if (this._length) this._buffer.copy(next, 0, 0, this._length);
            this._buffer = next;
        }
        bytes.copy(this._buffer, this._length, 0, bytes.length);
        this._length = required;
    }

    push(chunk) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const frames = [];
        let offset = 0;

        if (this._length) {
            if (!this._frameLength) {
                const count = Math.min(12 - this._length, bytes.length);
                this._append(bytes.subarray(0, count), 12);
                offset += count;
                if (this._length < 12) return frames;
                // A complete prelude validates CRC and size even when its body
                // has not arrived. Never allocate from an unchecked length.
                decodeKiroFrames(this._buffer.subarray(0, 12), this.maxFrameBytes);
                this._frameLength = this._buffer.readUInt32BE(0);
            }

            const count = Math.min(this._frameLength - this._length, bytes.length - offset);
            this._append(bytes.subarray(offset, offset + count), this._frameLength);
            offset += count;
            if (this._length < this._frameLength) return frames;
            frames.push(...decodeKiroFrames(this._buffer.subarray(0, this._length), this.maxFrameBytes).frames);
            this._buffer = null;
            this._length = 0;
            this._frameLength = 0;
        }

        if (offset < bytes.length) {
            const decoded = decodeKiroFrames(bytes.subarray(offset), this.maxFrameBytes);
            // Keep batch semantics: a later invalid frame throws before any
            // frames from this transport chunk reach the event mapper.
            for (const frame of decoded.frames) frames.push(frame);
            if (decoded.remaining.length) {
                if (decoded.remaining.length >= 12) this._frameLength = decoded.remaining.readUInt32BE(0);
                this._append(decoded.remaining, this._frameLength || 12);
            }
        }
        return frames;
    }

    finish() {
        if (this._length) throw kiroIntegrityError('truncated trailing event frame');
    }
}
