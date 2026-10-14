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

export function normalizeKiroStopReason(value) {
    if (!value) return null;
    const normalized = String(value).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    const reasons = { stop: 'end_turn', end_turn: 'end_turn', tool_use: 'tool_use', tool_calls: 'tool_use',
        max_tokens: 'max_tokens', max_output_tokens: 'max_tokens', length: 'max_tokens',
        model_context_window_exceeded: 'max_tokens', stop_sequence: 'stop_sequence' };
    return Object.hasOwn(reasons, normalized) ? reasons[normalized] : null;
}
