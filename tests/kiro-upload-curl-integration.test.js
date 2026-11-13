import { gzipSync, gunzipSync } from 'node:zlib';
import { sendCurl } from '../src/scripts/kiro-upload-curl.mjs';
import { createFixture } from './helpers/kiro-sidecar-fixture.js';

// Real curl and real TLS, exclusively against ephemeral localhost endpoints.
// This verifies the independent sender, not AWS's request compression support.
let fixture;
const json = Buffer.from(JSON.stringify({ test: 'same request 中文'.repeat(64), effort: 'probe-invalid-effort' }));
const reply = '{"message":"local fixture only"}';
const headersFor = (payload, gzip) => ({ 'Content-Type': 'application/json', Accept: 'application/json',
    Authorization: 'Bearer mock-only', 'Content-Length': String(payload.length),
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });

beforeAll(async () => { fixture = await createFixture(); }, 120000);
beforeEach(() => {
    fixture.requests.length = 0;
    fixture.connects.length = 0;
    fixture.handler = (_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json', 'x-amzn-errortype': 'ValidationException' });
        res.end(reply);
    };
});
afterAll(async () => { await fixture?.close(); });

test.each([false, true])('real curl preserves exact upload bytes and gzip=%s with HTTP/1.1', async gzip => {
    const payload = gzip ? gzipSync(json) : json;
    const result = await sendCurl(new URL(`${fixture.url}/encoding`), headersFor(payload, gzip), payload,
        { caFile: fixture.caFile, timeoutMs: 3000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(400);
    expect(result.text).toBe(reply);
    expect(result.headers['x-amzn-errortype']).toBe('ValidationException');
    expect(result.ttfbMs).toBeGreaterThan(0);
    expect(fixture.requests).toHaveLength(1);
    const received = fixture.requests[0];
    expect(received.version).toBe('1.1');
    expect(received.headers['content-encoding']).toBe(gzip ? 'gzip' : undefined);
    expect(received.headers.expect).toBeUndefined();
    expect(received.body).toEqual(payload);
    expect(gzip ? gunzipSync(received.body) : received.body).toEqual(json);
});

test('real curl forwards proxy authentication without classifying CONNECT 200 as generation', async () => {
    const payload = gzipSync(json);
    const result = await sendCurl(new URL(`${fixture.url}/encoding`), headersFor(payload, true), payload,
        { proxy: new URL(`http://test-user:test-password@127.0.0.1:${fixture.proxyPort}`),
            caFile: fixture.caFile, timeoutMs: 3000 });
    expect(result.error).toBeUndefined();
    expect(result.unsafe).toBeUndefined();
    expect(result.status).toBe(400);
    expect(result.text).toBe(reply);
    expect(fixture.connects).toHaveLength(1);
    expect(fixture.connects[0]['proxy-authorization']).toBe(`Basic ${Buffer.from('test-user:test-password').toString('base64')}`);
    expect(fixture.requests[0].body).toEqual(payload);
});

test('real curl aborts a 2xx response at headers without waiting for its open stream', async () => {
    fixture.handler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/vnd.amazon.eventstream' });
        res.flushHeaders();
        // Keep the stream open: a safe diagnostic must stop at the headers.
    };
    const result = await sendCurl(new URL(`${fixture.http1Url}/encoding`), headersFor(json, false), json,
        { caFile: fixture.caFile, timeoutMs: 3000 });
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ status: 200, unsafe: true, text: '' });
    expect(fixture.requests).toHaveLength(1);
});
