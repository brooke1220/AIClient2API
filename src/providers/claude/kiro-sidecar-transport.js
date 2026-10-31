import axios from 'axios';
import { getKiroSidecar } from '../../utils/kiro-sidecar.js';
import { resolveProxyUrlForProvider } from '../../utils/proxy-utils.js';
import { getNormalizedErrorResponseText, isRetryableNetworkError } from '../../utils/common.js';

export function markKiroSidecarError(error, code = 'SIDECAR_TRANSPORT_ERROR', retryable = false) {
    error.isKiroSidecarError = true;
    error.skipErrorCount = true;
    error.shouldSwitchCredential = false;
    error.isRetryableUpstreamResponseFailure = false;
    error.retryable = retryable;
    error.code = code;
    return error;
}

/** Match Axios's flattening of common, method-level and top-level headers. */
function outboundHeaders(instance, routed) {
    const merged = axios.mergeConfig(instance?.defaults || {}, routed);
    const headers = { ...merged.headers };
    const method = (routed.method || 'post').toLowerCase();
    const defaults = axios.AxiosHeaders.concat(headers.common, headers[method]);
    for (const key of ['common', 'delete', 'get', 'head', 'post', 'put', 'patch', 'options']) delete headers[key];
    return axios.AxiosHeaders.concat(defaults, headers);
}

function prepareRequest(instance, routed, config, context) {
    const headers = outboundHeaders(instance, routed);
    const proxy = resolveProxyUrlForProvider(config, config.MODEL_PROVIDER || 'claude-kiro-oauth', { forSidecar: true });
    const data = Buffer.isBuffer(routed.data) ? routed.data
        : Buffer.from((typeof routed.data === 'string' ? routed.data : JSON.stringify(routed.data)) ?? '');
    const limit = Number(config.KIRO_MAX_PAYLOAD_BYTES) > 0 ? Number(config.KIRO_MAX_PAYLOAD_BYTES) : 10 * 1024 * 1024;
    if (data.length > limit) {
        const error = markKiroSidecarError(new Error('Final Kiro request exceeds the payload limit'), 'REQUEST_TOO_LARGE');
        error.status = 413;
        throw error;
    }
    const connectionHeaders = String(headers.get('connection') || '').split(',').map(name => name.trim()).filter(Boolean);
    for (const name of [...connectionHeaders, 'host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade',
        'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'x-target-url', 'x-proxy-url',
        'x-kiro-sidecar-token', 'x-kiro-protocol-version']) headers.delete(name);
    headers.setContentType('application/json', false);
    headers.set('X-Kiro-Sidecar-Token', context.localToken);
    headers.set('X-Kiro-Protocol-Version', '1');
    headers.set('X-Target-Url', routed.url);
    if (proxy) headers.set('X-Proxy-Url', proxy);
    return { headers, data };
}

export async function requestViaKiroSidecar(instance, routed, config, context) {
    context ||= getKiroSidecar().getTransportContext();
    if (!context?.baseUrl || !context.localToken) {
        throw markKiroSidecarError(new Error('Kiro sidecar instance is unavailable'), 'SIDECAR_UNAVAILABLE', true);
    }
    let prepared;
    try { prepared = prepareRequest(instance, routed, config, context); }
    catch (error) {
        if (error.isKiroSidecarError) throw error;
        throw markKiroSidecarError(new Error('Invalid Kiro sidecar request configuration'), 'SIDECAR_REQUEST_ERROR');
    }

    let response;
    try {
        response = await axios.request({
            method: 'post', url: `${context.baseUrl}/stream`, baseURL: undefined,
            ...prepared, responseType: 'stream', timeout: 0, signal: routed.signal,
            httpAgent: context.agent, httpsAgent: undefined, proxy: false, maxRedirects: 0,
            validateStatus: () => true, decompress: instance?.defaults?.decompress ?? true,
        });
    } catch (error) {
        throw markKiroSidecarError(error, 'SIDECAR_CONNECTION_ERROR', isRetryableNetworkError(error));
    }
    const source = response.headers['x-kiro-response-source'];
    const version = response.headers['x-kiro-protocol-version'];
    if (version !== '1' || !['sidecar', 'upstream'].includes(source)) {
        response.data.destroy();
        throw markKiroSidecarError(new Error('Invalid Kiro sidecar response protocol'), 'SIDECAR_PROTOCOL_ERROR');
    }
    if (source === 'sidecar') {
        let detail;
        try {
            const raw = await getNormalizedErrorResponseText({ response }, {
                signal: routed.signal, rawBody: true, maxBytes: 64 * 1024, timeoutMs: 3000,
            });
            detail = JSON.parse(raw);
        } catch (error) {
            routed.signal?.throwIfAborted();
            throw markKiroSidecarError(new Error('Invalid Kiro sidecar error body'), 'SIDECAR_PROTOCOL_ERROR');
        }
        const valid = response.status >= 400 && detail?.source === 'sidecar'
            && typeof detail.code === 'string' && typeof detail.retryable === 'boolean';
        const error = new Error(valid ? `Kiro sidecar ${detail.code}` : 'Invalid Kiro sidecar error body');
        error.response = response;
        throw markKiroSidecarError(error, valid ? detail.code : 'SIDECAR_PROTOCOL_ERROR', valid && detail.retryable);
    }
    delete response.headers['x-kiro-response-source'];
    delete response.headers['x-kiro-protocol-version'];
    if (response.status < 200 || response.status >= 300) {
        throw new axios.AxiosError(`Request failed with status code ${response.status}`, 'ERR_BAD_RESPONSE',
            response.config, response.request, response);
    }
    response.data.on('error', error => {
        markKiroSidecarError(error, 'SIDECAR_STREAM_ERROR', true);
        if (!response.data.destroyed) response.data.destroy(error);
    });
    return response;
}
