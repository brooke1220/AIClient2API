import { TextDecoder } from 'node:util';
/** Strict AWS Event Stream decoding. No resynchronization after corruption. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    return crc >>> 0;
});

export function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
}

export function kiroIntegrityError(reason) {
    const error = new Error(`Kiro upstream stream failed: ${reason}`);
    error.status = 502;
    error.code = 'KIRO_STREAM_INTEGRITY';
    error.skipErrorCount = true;
    error.isRetryableUpstreamResponseFailure = true;
    error.responseFailureLabel = reason;
    if (reason === 'truncated trailing event frame') {
        error.recoveryHint = 'The transport ended with an incomplete event frame. Do not treat this as successful completion or automatically replay earlier tool calls.';
    } else if (['incomplete tool argument JSON', 'unfinished empty tool call', 'invalid legacy tool argument JSON', 'incomplete legacy tool call'].includes(reason)) {
        error.recoveryHint = 'Request a smaller valid tool call instead of repairing partial JSON or replaying completed calls. No malformed tool call was emitted.';
    }
    if (error.recoveryHint) error.message += ` ${error.recoveryHint}`;
    return error;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
function utf8(bytes) {
    try { return UTF8.decode(bytes); }
    catch { throw kiroIntegrityError('invalid event UTF-8'); }
}

function readHeaders(bytes) {
    const headers = Object.create(null);
    let offset = 0;
    const take = length => {
        if (offset + length > bytes.length) throw kiroIntegrityError('truncated event header');
        const value = bytes.subarray(offset, offset + length);
        offset += length;
        return value;
    };
    while (offset < bytes.length) {
        const nameLength = take(1)[0];
        if (!nameLength) throw kiroIntegrityError('empty event header name');
        const name = utf8(take(nameLength));
        if (Object.hasOwn(headers, name)) throw kiroIntegrityError('duplicate event header');
        const type = take(1)[0];
        if (type === 0 || type === 1) headers[name] = type === 0;
        else if (type === 6 || type === 7) {
            const value = take(take(2).readUInt16BE(0));
            headers[name] = type === 7 ? utf8(value) : value;
        } else {
            const length = { 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }[type];
            if (!length) throw kiroIntegrityError('invalid event header type');
            headers[name] = take(length);
        }
    }
    return headers;
}

export function decodeKiroFrames(buffer, maxFrameBytes = 32 * 1024 * 1024) {
    const configuredLimit = Number(maxFrameBytes);
    const limit = Number.isFinite(configuredLimit) && configuredLimit >= 16 ? configuredLimit : 32 * 1024 * 1024;
    const frames = [];
    let offset = 0;
    while (buffer.length - offset >= 12) {
        const prelude = buffer.subarray(offset, offset + 12);
        if (crc32(prelude.subarray(0, 8)) !== prelude.readUInt32BE(8)) throw kiroIntegrityError('prelude CRC mismatch');
        const length = prelude.readUInt32BE(0);
        const headersLength = prelude.readUInt32BE(4);
        if (length < 16 || length > limit || headersLength > length - 16) throw kiroIntegrityError('invalid event frame length');
        if (buffer.length - offset < length) break;
        const frame = buffer.subarray(offset, offset + length);
        if (crc32(frame.subarray(0, -4)) !== frame.readUInt32BE(length - 4)) throw kiroIntegrityError('message CRC mismatch');
        const headers = readHeaders(frame.subarray(12, 12 + headersLength));
        for (const name of [':message-type', ':event-type', ':exception-type', ':error-code', ':error-message']) {
            if (headers[name] !== undefined && typeof headers[name] !== 'string') throw kiroIntegrityError('invalid reserved header type');
        }
        const payload = utf8(frame.subarray(12 + headersLength, length - 4));
        const messageType = headers[':message-type'];
        let data = {};
        if (payload) {
            try { data = JSON.parse(payload); }
            catch { throw kiroIntegrityError('invalid event payload JSON'); }
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw kiroIntegrityError('event payload must be a JSON object');
        if (messageType === 'error' || messageType === 'exception' || headers[':exception-type'] || headers[':error-code']) {
            const error = kiroIntegrityError('upstream exception');
            error.upstreamCode = headers[':exception-type'] || headers[':error-code'];
            error.message = `Kiro upstream ${error.upstreamCode || messageType}: ${String(headers[':error-message'] || data.message || 'upstream failure').slice(0, 500)}`;
            throw error;
        }
        if (messageType && messageType !== 'event') throw kiroIntegrityError('invalid event message type');
        frames.push({ headers, data });
        offset += length;
    }
    return { frames, remaining: buffer.subarray(offset) };
}

/**
 * Resilient AWS Event Stream decoder with error recovery.
 * On prelude CRC mismatch: scans forward byte-by-byte for next valid prelude (one error event).
 * On message CRC / parse error: skips the entire frame and continues.
 * Stops after MAX_CONSECUTIVE_ERRORS consecutive unrecoverable failures.
 * Returns { frames, remaining, errors } — `errors` counts recovered corruptions.
 */
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_RESYNC_SCAN = 256 * 1024; // scan up to 256 KB for next valid prelude

function scanForNextPrelude(buffer, start, limit) {
    const end = Math.min(buffer.length - 12, start + MAX_RESYNC_SCAN);
    for (let pos = start + 1; pos <= end; pos++) {
        const prelude = buffer.subarray(pos, pos + 12);
        if (crc32(prelude.subarray(0, 8)) !== prelude.readUInt32BE(8)) continue;
        const len = prelude.readUInt32BE(0);
        const hLen = prelude.readUInt32BE(4);
        if (len >= 16 && len <= limit && hLen <= len - 16) return pos;
    }
    return -1;
}

function tryDecodeOneFrame(buffer, offset, limit) {
    if (buffer.length - offset < 12) return { status: 'incomplete' };
    const prelude = buffer.subarray(offset, offset + 12);
    if (crc32(prelude.subarray(0, 8)) !== prelude.readUInt32BE(8)) return { status: 'prelude_crc' };
    const length = prelude.readUInt32BE(0);
    const headersLength = prelude.readUInt32BE(4);
    if (length < 16 || length > limit || headersLength > length - 16) return { status: 'prelude_crc' };
    if (buffer.length - offset < length) return { status: 'incomplete' };
    const frame = buffer.subarray(offset, offset + length);
    if (crc32(frame.subarray(0, -4)) !== frame.readUInt32BE(length - 4)) return { status: 'message_crc', skip: length };
    try {
        const headers = readHeaders(frame.subarray(12, 12 + headersLength));
        for (const name of [':message-type', ':event-type', ':exception-type', ':error-code', ':error-message']) {
            if (headers[name] !== undefined && typeof headers[name] !== 'string') return { status: 'parse_error', skip: length };
        }
        const payload = utf8(frame.subarray(12 + headersLength, length - 4));
        const messageType = headers[':message-type'];
        let data = {};
        if (payload) { data = JSON.parse(payload); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return { status: 'parse_error', skip: length };
        // Upstream exceptions are still fatal — not recoverable corruption
        if (messageType === 'error' || messageType === 'exception' || headers[':exception-type'] || headers[':error-code']) {
            const error = kiroIntegrityError('upstream exception');
            error.upstreamCode = headers[':exception-type'] || headers[':error-code'];
            error.message = `Kiro upstream ${error.upstreamCode || messageType}: ${String(headers[':error-message'] || data.message || 'upstream failure').slice(0, 500)}`;
            return { status: 'fatal', error };
        }
        if (messageType && messageType !== 'event') return { status: 'parse_error', skip: length };
        return { status: 'ok', frame: { headers, data }, advance: length };
    } catch (e) {
        if (e.code === 'KIRO_STREAM_INTEGRITY' && e.responseFailureLabel === 'upstream exception') return { status: 'fatal', error: e };
        return { status: 'parse_error', skip: length };
    }
}

export function decodeKiroFramesResilient(buffer, maxFrameBytes = 32 * 1024 * 1024) {
    const configuredLimit = Number(maxFrameBytes);
    const limit = Number.isFinite(configuredLimit) && configuredLimit >= 16 ? configuredLimit : 32 * 1024 * 1024;
    const frames = [];
    let offset = 0;
    let consecutiveErrors = 0;
    let totalErrors = 0;

    while (buffer.length - offset >= 12) {
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
        const result = tryDecodeOneFrame(buffer, offset, limit);
        if (result.status === 'ok') {
            frames.push(result.frame);
            offset += result.advance;
            consecutiveErrors = 0;
        } else if (result.status === 'incomplete') {
            break;
        } else if (result.status === 'fatal') {
            throw result.error;
        } else if (result.status === 'prelude_crc') {
            // Scan forward for next valid prelude (counts as one error event)
            const next = scanForNextPrelude(buffer, offset, limit);
            if (next < 0) break; // no valid frame ahead, treat rest as remaining
            offset = next;
            consecutiveErrors++;
            totalErrors++;
        } else {
            // message_crc or parse_error: skip entire frame
            offset += result.skip || 1;
            consecutiveErrors++;
            totalErrors++;
        }
    }
    return { frames, remaining: buffer.subarray(offset), errors: totalErrors };
}

export function normalizeKiroStopReason(value) {
    if (!value) return null;
    const normalized = String(value).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    const reasons = { stop: 'end_turn', end_turn: 'end_turn', tool_use: 'tool_use', tool_calls: 'tool_use',
        max_tokens: 'max_tokens', max_output_tokens: 'max_tokens', length: 'max_tokens',
        model_context_window_exceeded: 'max_tokens', stop_sequence: 'stop_sequence' };
    return Object.hasOwn(reasons, normalized) ? reasons[normalized] : null;
}
