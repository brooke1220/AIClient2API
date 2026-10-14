import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
import { KiroApiService } from '../../src/providers/claude/claude-kiro.js';

export function crc(buffer) {
    let value = 0xffffffff;
    for (const byte of buffer) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
}
export function frame(type, payload, extra = {}) {
    const headers = Buffer.concat(Object.entries({ ':message-type': 'event', ...(type ? { ':event-type': type } : {}), ...extra }).map(([key, value]) => {
        const name = Buffer.from(key), data = Buffer.from(value), size = Buffer.alloc(2);
        size.writeUInt16BE(data.length);
        return Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7]), size, data]);
    }));
    const data = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
    const bytes = Buffer.alloc(headers.length + data.length + 16);
    bytes.writeUInt32BE(bytes.length, 0); bytes.writeUInt32BE(headers.length, 4);
    bytes.writeUInt32BE(crc(bytes.subarray(0, 8)), 8); headers.copy(bytes, 12); data.copy(bytes, 12 + headers.length);
    bytes.writeUInt32BE(crc(bytes.subarray(0, -4)), bytes.length - 4);
    return bytes;
}
export const text = value => frame('assistantResponseEvent', { content: value });
export const tool = data => frame('toolUseEvent', data);
export const request = () => ({ messages: [{ role: 'user', content: 'hello' }] });
export const model = 'claude-sonnet-4-5';
export const openStream = () => new Readable({ read() {} });
export function service(frames = [text('answer')], config = {}) {
    const value = Object.create(KiroApiService.prototype);
    Object.assign(value, {
        config: { REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 1, ...config }, isInitialized: true,
        accessToken: 'mock-only', baseUrl: 'https://mock.invalid/generateAssistantResponse',
        codewhispererBaseUrl: 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse', region: 'us-east-1',
        _prepareAccessTokenForRequest: jest.fn(async () => {}), _applySidecar: jest.fn(),
        buildCodewhispererRequest: jest.fn(async () => ({})), estimateInputTokens: () => 12, countTextTokens: value => value.length,
        _requestWithBuilderEndpointRouting: jest.fn(async () => ({ data: Readable.from(frames) }))
    });
    return value;
}
export async function collect(stream) { const values = []; for await (const value of stream) values.push(value); return values; }
export const tick = () => new Promise(resolve => setImmediate(resolve));
export async function bounded(promise, ms = 500) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Operation did not settle')), ms); })]); }
    finally { clearTimeout(timer); }
}
export function response() {
    const value = new EventEmitter();
    value.writeHead = jest.fn(); value.flushHeaders = jest.fn(); value.write = jest.fn(() => true);
    value.writableEnded = false;
    value.end = jest.fn(() => { value.writableEnded = true; });
    return value;
}
