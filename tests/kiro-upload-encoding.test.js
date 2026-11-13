import https from 'node:https';
import { gunzipSync } from 'node:zlib';
import axios from 'axios';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { requestViaKiroSidecar } from '../src/providers/claude/kiro-sidecar-transport.js';
import { encode, headersFor, prepareBody, send } from '../src/scripts/kiro-upload-probe.mjs';
import { createFixture, readBody } from './helpers/kiro-sidecar-fixture.js';

// Diagnostic coverage of the current transports, not a claim that AWS accepts
// gzip requests. Every target is this fixture's local TLS server. Its response
// is always the same HTTP 400, independent of the uploaded bytes or headers.
const MODEL = 'claude-opus-5.5';
const INVALID_EFFORT = 'probe-invalid-effort';
const LOCAL_REPLY = JSON.stringify({ message: 'Local encoding fixture only.' });
const REQUEST_HEADERS = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Bearer mock-only',
    'amz-sdk-request': 'attempt=1; max=3',
    'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse'
};

let fixture, sidecar, json, prepared;
const agents = new Set();

beforeAll(async () => {
    fixture = await createFixture();

    // Bypass constructor/initialize/loadCredentials entirely. Only call the
    // production's pure request conversion with synthetic, text-only input.
    const backend = Object.create(KiroApiService.prototype);
    backend.config = { KIRO_TRUNCATION_RECOVERY: false, KIRO_PROMPT_CACHE_MODE: 'off' };
    const payload = await backend.buildCodewhispererRequest([
        { role: 'user', content: 'Local upload encoding test. 中文内容。 '.repeat(64) }
    ], MODEL);

    // Inject after production conversion: its effort mapper normalizes invalid
    // input values. The final serialized probe must retain this invalid value.
    payload.additionalModelRequestFields = { output_config: { effort: INVALID_EFFORT } };
    prepared = prepareBody(payload, 'production-local');
    json = prepared.json;
}, 120000);

beforeEach(() => {
    fixture.requests.length = 0;
    fixture.handler = (_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(LOCAL_REPLY);
    };
});

afterEach(async () => {
    await sidecar?.stop();
    sidecar = undefined;
    for (const agent of agents) agent.destroy();
    agents.clear();
});

afterAll(async () => { await fixture?.close(); });

test('uses the real request builder, including its tool context, before injecting the probe effort', () => {
    const payload = JSON.parse(json);
    const current = payload.conversationState.currentMessage.userInputMessage;
    expect(current.modelId).toBe(MODEL);
    expect(current.userInputMessageContext.tools.length).toBeGreaterThan(0);
    expect(payload.additionalModelRequestFields.output_config.effort).toBe(INVALID_EFFORT);
    expect(json.toString()).toContain('中文内容');
});

test.each([false, true])('Node probe preserves the exact body and gzip=%s declaration', async gzip => {
    const { payload } = encode(prepared, gzip);
    const headers = headersFor('mock-only', payload, gzip);
    const agent = new https.Agent({ ca: fixture.ca, keepAlive: true, maxSockets: 1 });
    agents.add(agent);

    const result = await send(agent, new URL(`${fixture.http1Url}/encoding`), headers, payload);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(400);
    expect(result.text).toBe(LOCAL_REPLY);
    expect(fixture.requests).toHaveLength(1);

    const received = fixture.requests[0];
    expect(received.headers['content-encoding']).toBe(gzip ? 'gzip' : undefined);
    expect(received.body).toEqual(payload);
    expect(gzip ? gunzipSync(received.body) : received.body).toEqual(json);
});

test.each([false, true])('Rust production transport preserves body bytes with gzip=%s and its current header filtering', async gzip => {
    sidecar = await fixture.start();
    const { payload } = encode(prepared, gzip);
    const instance = axios.create({ proxy: false, headers: REQUEST_HEADERS });
    let response;
    try {
        await requestViaKiroSidecar(instance, {
            method: 'post',
            url: `${fixture.url}/encoding`,
            data: payload,
            headers: gzip ? { 'Content-Encoding': 'gzip' } : {}
        }, {}, sidecar.context);
        throw new Error('The local encoding fixture must return HTTP 400.');
    } catch (error) {
        expect(error.response?.status).toBe(400);
        response = error.response;
    }
    expect((await readBody(response.data)).toString()).toBe(LOCAL_REPLY);
    expect(fixture.requests).toHaveLength(1);

    const received = fixture.requests[0];
    // Record the current behavior: Rust drops Content-Encoding while passing
    // the compressed bytes through unchanged. Update this diagnostic if the
    // production forwarding policy changes; do not infer AWS gzip support.
    expect(received.headers['content-encoding']).toBeUndefined();
    expect(received.body).toEqual(payload);
    expect(gzip ? gunzipSync(received.body) : received.body).toEqual(json);
});
