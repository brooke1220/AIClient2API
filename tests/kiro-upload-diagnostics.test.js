import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { createFixture } from './helpers/kiro-sidecar-fixture.js';

const EFFORT_ERROR = 'Invalid additionalModelRequestFields: does not have a value in the enumeration ["low", "medium", "high", "xhigh", "max"]';
const FORMAT_ERROR = 'Improperly formed request.';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Only local TLS listeners receive these CLI requests. The temporary credentials
// are synthetic, and every mocked upstream reply is an error, never generation.
describe('upload probe CLI against local independent clients', () => {
    let fixture, directory;
    const children = new Set();
    const respond = (res, type, message, status = 400) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'x-amzn-errortype': type });
        res.end(JSON.stringify({ reason: 'REQUEST_BODY_INVALID', message }));
    };

    beforeAll(async () => {
        fixture = await createFixture();
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-upload-diagnostics-'));
    }, 120000);
    beforeEach(() => { fixture.requests.length = 0; });
    afterEach(() => { for (const child of children) child.kill('SIGKILL'); children.clear(); });
    afterAll(async () => {
        await fixture?.close();
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
    });

    async function runProbe({ sizes = '1k,450k,900k', client = 'both' } = {}) {
        const runDirectory = fs.mkdtempSync(path.join(directory, 'run-'));
        const credentials = path.join(runDirectory, 'mock-creds.json');
        const config = path.join(runDirectory, 'config.json');
        const output = path.join(runDirectory, 'result.json');
        fs.writeFileSync(credentials, JSON.stringify({ accessToken: 'mock-local-token', authMethod: 'social',
            region: 'us-east-1', expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }), { mode: 0o600 });
        fs.writeFileSync(config, '{}');
        const child = spawn(process.execPath, ['src/scripts/kiro-upload-probe.mjs',
            '--creds', credentials, '--config', config,
            '--endpoint', `${fixture.http1Url}/generateAssistantResponse`, '--proxy', 'none',
            '--sizes', sizes, '--check-only', '--client', client, '--gap-ms', '0', '--json', output
        ], { cwd: process.cwd(), env: { ...process.env, NODE_EXTRA_CA_CERTS: fixture.caFile,
            CURL_CA_BUNDLE: fixture.caFile }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        return await new Promise((resolve, reject) => {
            let stdout = '', stderr = '';
            const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Local upload diagnostic CLI timed out')); }, 15000);
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
            child.on('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
            child.on('close', code => {
                clearTimeout(timer);
                children.delete(child);
                resolve({ code, stdout, stderr, result: fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null });
            });
        });
    }

    test('checks all three sizes with Node and curl after small gzip rejection, using identical JSON', async () => {
        fixture.handler = (req, res) => req.headers['content-encoding'] === 'gzip'
            ? respond(res, 'SerializationException', FORMAT_ERROR)
            : respond(res, 'ValidationException', EFFORT_ERROR);
        const { code, stdout, stderr, result } = await runProbe();
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(result).toMatchObject({ clients: ['node', 'curl'], gzipVerdict: 'rejected', gzipAccepted: false,
            independentAgreement: true, clientDependent: false, sizeDependent: false, fit: null, summary: [] });
        expect(result.checks).toHaveLength(6);
        expect(result.samples).toHaveLength(12);
        expect(fixture.requests).toHaveLength(12);
        expect(result.samples.filter(sample => sample.client === 'node')).toHaveLength(6);
        expect(result.samples.filter(sample => sample.client === 'curl')).toHaveLength(6);
        expect(stdout).toContain('Node and curl independently agree');
        expect(stdout).not.toContain('Node timing');
        expect(stdout + stderr).not.toContain('mock-local-token');
        for (const size of ['1k', '450k', '900k']) {
            const samples = result.samples.filter(sample => sample.size === size);
            expect(samples).toHaveLength(4);
            expect(samples.filter(sample => sample.gzip)).toHaveLength(2);
            expect(new Set(samples.map(sample => sample.jsonSha256)).size).toBe(1);
            const checkHashes = result.checks.filter(check => check.size === size).map(check => check.jsonSha256);
            expect(new Set([...checkHashes, samples[0].jsonSha256]).size).toBe(1);
        }
        result.samples.forEach((sample, index) => {
            const received = fixture.requests[index];
            expect(received.headers['content-encoding']).toBe(sample.gzip ? 'gzip' : undefined);
            expect(received.headers['content-length']).toBe(String(received.body.length));
            const original = sample.gzip ? gunzipSync(received.body) : received.body;
            expect(digest(original)).toBe(sample.jsonSha256);
            expect(digest(received.body)).toBe(sample.wireSha256);
            expect(JSON.parse(original).additionalModelRequestFields.output_config.effort).toBe('probe-invalid-effort');
        });
    }, 20000);

    test('reports independently supported gzip when both clients reach invalid-effort validation', async () => {
        fixture.handler = (_req, res) => respond(res, 'ValidationException', EFFORT_ERROR);
        const { code, result } = await runProbe({ sizes: '1k' });
        expect(code).toBe(0);
        expect(result).toMatchObject({ gzipAccepted: true, gzipVerdict: 'supported', independentAgreement: true, fit: null });
        expect(result.checks.every(check => check.verdict === 'supported')).toBe(true);
        expect(fixture.requests).toHaveLength(4);
    }, 20000);

    test('reports rate-limited gzip as inconclusive for both independent clients', async () => {
        fixture.handler = (req, res) => req.headers['content-encoding'] === 'gzip'
            ? respond(res, 'ThrottlingException', 'Rate limit exceeded', 429)
            : respond(res, 'ValidationException', EFFORT_ERROR);
        const { code, result } = await runProbe({ sizes: '1k' });
        expect(code).toBe(0);
        expect(result).toMatchObject({ gzipAccepted: null, gzipVerdict: 'inconclusive', independentAgreement: false, fit: null });
        expect(result.checks.every(check => check.verdict === 'inconclusive')).toBe(true);
        expect(fixture.requests).toHaveLength(4);
    }, 20000);

    test('stops the whole CLI before the next size or client after unexpected gzip success', async () => {
        fixture.handler = (req, res) => req.headers['content-encoding'] === 'gzip'
            ? respond(res, 'UnexpectedSuccess', 'No real generation in this fixture', 200)
            : respond(res, 'ValidationException', EFFORT_ERROR);
        const { code, stderr, result } = await runProbe();
        expect(code).toBe(2);
        expect(stderr).toContain('Kiro returned HTTP 200');
        expect(result).toBeNull();
        expect(fixture.requests).toHaveLength(2);
    }, 20000);
});
