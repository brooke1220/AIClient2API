/** Independent curl transport used only by the upload diagnostic. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const MAX_RESPONSE_BYTES = 8192;
const MAX_HEADER_BYTES = 65536;
const TIMING_MARKER = '__KIRO_PROBE_TTFB__';
const configQuote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const transportError = (message, code) => Object.assign(new Error(message), { code });

/**
 * Send exactly the supplied bytes with curl, without exposing credentials in
 * process arguments or returning curl's potentially sensitive error output.
 * The temporary config is removed before resolving, including on a 2xx abort.
 */
export function sendCurl(url, headers, payload, {
    proxy = null, timeoutMs = 120000, caFile, spawnImpl = spawn
} = {}) {
    return new Promise(resolve => {
        const startedAt = performance.now();
        let directory, child, timer, headerWatcher, headerPoll, responseHeaderPath;
        let headerBytesRead = 0;
        let settled = false, status = null, responseHeaders = {}, ttfbMs = null;
        let pendingHeaders = Buffer.alloc(0), finalHeaders = false;
        const body = [];
        let bodyBytes = 0;
        let stderrTail = '';
        const finish = extra => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(headerPoll);
            headerWatcher?.close();
            if (directory) fs.rmSync(directory, { recursive: true, force: true });
            resolve({ status, headers: responseHeaders, text: Buffer.concat(body).toString('utf8'),
                ttfbMs, writeMs: null, reusedSocket: false, ...extra });
        };
        const stop = error => {
            child?.kill('SIGKILL');
            finish({ error });
        };
        const retainBody = chunk => {
            if (bodyBytes >= MAX_RESPONSE_BYTES) return;
            const part = chunk.subarray(0, MAX_RESPONSE_BYTES - bodyBytes);
            body.push(part);
            bodyBytes += part.length;
        };
        const onHeaders = chunk => {
            if (settled) return;
            if (finalHeaders) return;
            pendingHeaders = Buffer.concat([pendingHeaders, chunk]);
            for (;;) {
                const end = pendingHeaders.indexOf('\r\n\r\n');
                if (end < 0) {
                    if (pendingHeaders.length > MAX_HEADER_BYTES) stop(transportError('curl response headers exceeded the diagnostic limit', 'CURL_PROTOCOL_ERROR'));
                    return;
                }
                if (end > MAX_HEADER_BYTES) { stop(transportError('curl response headers exceeded the diagnostic limit', 'CURL_PROTOCOL_ERROR')); return; }
                const lines = pendingHeaders.subarray(0, end).toString('latin1').split('\r\n');
                const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/.exec(lines.shift());
                if (!match) { stop(transportError('curl returned invalid response framing', 'CURL_PROTOCOL_ERROR')); return; }
                const parsedStatus = Number(match[1]);
                pendingHeaders = pendingHeaders.subarray(end + 4);
                // CONNECT headers are suppressed by curl. HTTP 100/103 may still
                // precede the final upstream response and are not success replies.
                if (parsedStatus >= 100 && parsedStatus < 200 && parsedStatus !== 101) continue;
                status = parsedStatus;
                ttfbMs = performance.now() - startedAt;
                responseHeaders = {};
                for (const line of lines) {
                    const colon = line.indexOf(':');
                    if (colon > 0) responseHeaders[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
                }
                finalHeaders = true;
                if (status >= 200 && status < 300) {
                    child.kill('SIGKILL');
                    finish({ unsafe: true });
                    return;
                }
                pendingHeaders = Buffer.alloc(0);
                return;
            }
        };
        const readHeaders = () => {
            if (settled || finalHeaders) return;
            try {
                const stat = fs.statSync(responseHeaderPath);
                if (stat.size > MAX_HEADER_BYTES * 4) {
                    stop(transportError('curl response headers exceeded the diagnostic limit', 'CURL_PROTOCOL_ERROR'));
                    return;
                }
                if (stat.size > headerBytesRead) {
                    const bytes = fs.readFileSync(responseHeaderPath);
                    const added = bytes.subarray(headerBytesRead);
                    headerBytesRead = bytes.length;
                    onHeaders(added);
                }
            } catch {
                stop(transportError('curl response headers could not be read', 'CURL_PROTOCOL_ERROR'));
            }
        };

        try {
            const endpoint = new URL(url);
            if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
                throw transportError('curl diagnostic targets must be HTTPS URLs without credentials', 'CURL_CONFIG_ERROR');
            }
            if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                throw transportError('curl timeout must be a positive number', 'CURL_CONFIG_ERROR');
            }
            const values = [endpoint.href, proxy?.href || proxy || '', caFile || ''];
            const entries = Object.entries(headers);
            for (const [name, value] of entries) {
                if (!/^[!#$%&'*+.^_`|~\dA-Za-z-]+$/.test(name) || /[\r\n\0]/.test(String(value))) {
                    throw transportError('curl diagnostic received an invalid HTTP header', 'CURL_CONFIG_ERROR');
                }
            }
            if (values.some(value => /[\r\n\0]/.test(String(value)))) {
                throw transportError('curl diagnostic received an invalid configuration value', 'CURL_CONFIG_ERROR');
            }
            directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-curl-probe-'));
            fs.chmodSync(directory, 0o700);
            const configPath = path.join(directory, 'request.conf');
            responseHeaderPath = path.join(directory, 'response.headers');
            fs.writeFileSync(responseHeaderPath, '', { mode: 0o600 });
            const config = [
                `url = ${configQuote(endpoint.href)}`,
                'request = "POST"',
                `max-time = ${configQuote(timeoutMs / 1000)}`,
                `noproxy = ${configQuote(proxy ? '' : '*')}`,
                ...(proxy ? [`proxy = ${configQuote(proxy.href || proxy)}`] : []),
                ...(caFile ? [`cacert = ${configQuote(caFile)}`] : []),
                ...entries.map(([name, value]) => `header = ${configQuote(`${name}: ${value}`)}`),
                // Disable curl's automatic Expect: 100-continue on larger bodies.
                ...(!entries.some(([name]) => name.toLowerCase() === 'expect') ? ['header = "Expect:"'] : [])
            ].join('\n') + '\n';
            fs.writeFileSync(configPath, config, { mode: 0o600 });
            const args = ['--disable', '--config', configPath, '--http1.1', '--proto', '=https',
                '--max-redirs', '0', '--retry', '0', '--silent', '--show-error', '--no-buffer', '--suppress-connect-headers',
                '--dump-header', responseHeaderPath, '--data-binary', '@-', '--write-out', `%{stderr}\n${TIMING_MARKER}%{time_starttransfer}\n`];
            child = spawnImpl('curl', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
            // A separate dump-header file is flushed by curl even when the
            // response body has not begun. --include buffers these headers on
            // some curl versions, so it cannot enforce the 2xx early stop.
            headerWatcher = fs.watch(responseHeaderPath, readHeaders);
            headerWatcher.on('error', () => stop(transportError('curl response header monitoring failed', 'CURL_PROTOCOL_ERROR')));
            headerPoll = setInterval(readHeaders, 25);
            child.stdout.on('data', chunk => {
                readHeaders();
                if (!settled) retainBody(chunk);
            });
            child.stderr.on('data', chunk => {
                // Retain only enough to parse our timing marker, never expose it.
                stderrTail = (stderrTail + chunk.toString('utf8')).slice(-1024);
            });
            child.stdin.on('error', () => {}); // An early upstream reply can close stdin.
            child.on('error', error => finish({ error: transportError(
                error.code === 'ENOENT' ? 'curl is not installed or is not on PATH' : 'curl could not be started',
                error.code === 'ENOENT' ? 'CURL_UNAVAILABLE' : 'CURL_START_ERROR') }));
            child.on('close', code => {
                if (settled) return;
                readHeaders();
                if (settled) return;
                const timing = new RegExp(`${TIMING_MARKER}(\\d+(?:\\.\\d+)?)`).exec(stderrTail);
                if (timing && Number(timing[1]) > 0) ttfbMs = Number(timing[1]) * 1000;
                if (code !== 0) {
                    finish({ error: transportError(code === 28 ? 'curl request timed out' : `curl transport failed (exit ${Number.isInteger(code) ? code : 'unknown'})`,
                        code === 28 ? 'ETIMEDOUT' : `CURL_EXIT_${Number.isInteger(code) ? code : 'UNKNOWN'}`) });
                } else if (!finalHeaders) {
                    finish({ error: transportError('curl did not return final HTTP response headers', 'CURL_PROTOCOL_ERROR') });
                } else finish({});
            });
            timer = setTimeout(() => stop(transportError('curl diagnostic exceeded its total deadline', 'ETIMEDOUT')), timeoutMs);
            child.stdin.end(payload);
        } catch (error) {
            child?.kill('SIGKILL');
            finish({ error: String(error.code || '').startsWith('CURL_') ? error : transportError('curl diagnostic could not prepare the request', 'CURL_CONFIG_ERROR') });
        }
    });
}
