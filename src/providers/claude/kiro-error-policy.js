// Usage caps (HOURLY…MONTHLY_REQUEST_COUNT, USAGE_LIMIT_REACHED) are per account, like the
// rate limits: Kiro IDE stops on them instead of retrying, so the pool cools the account down.
const KIRO_ACCOUNT_THROTTLE_REASON = /^(?:SERVICE_REQUEST_RATE_EXCEEDED|USER_REQUEST_RATE_EXCEEDED|CREDIT_CONSUMPTION_RATE_EXCEEDED|ACCOUNT_RATE_LIMIT_EXCEEDED|(?:HOURLY|DAILY|WEEKLY|MONTHLY)_REQUEST_COUNT|USAGE_LIMIT_REACHED)$/;
const KIRO_CAPACITY_THROTTLE_REASON = /^(?:CAPACITY_EXCEEDED|INSUFFICIENT_MODEL_CAPACITY|MODEL_TEMPORARILY_UNAVAILABLE)$/;
// Kiro IDE reads this INSUFFICIENT_MODEL_CAPACITY message as "this account is blocked", not capacity.
const KIRO_NEW_USER_PAUSED = /Kiro temporarily paused new .* users at this time/i;
// Kiro IDE's input-too-long phrases; they apply even when the reason field is absent or different.
const KIRO_INPUT_TOO_LONG = /CONTENT_LENGTH_EXCEEDS_THRESHOLD|input is too long|prompt is too long|input content length exceeds threshold/i;
const KIRO_RETRY_AFTER_HEADER = 'x-amzn-kiro-ratelimit-retry-after';
const KIRO_MODEL_UNAVAILABLE_RETRY_MS = 5000;

// Kiro IDE accepts both spellings, in `:exception-type` and as an error-typed `:event-type`.
const KIRO_STREAM_EXCEPTION_KIND = {
    error: 'internal', internalserverexception: 'internal',
    throttlingerror: 'throttling', throttlingexception: 'throttling',
    validationerror: 'validation', validationexception: 'validation',
    serviceunavailableerror: 'unavailable', serviceunavailableexception: 'unavailable'
};

function streamExceptionKind(type) {
    return typeof type === 'string' ? KIRO_STREAM_EXCEPTION_KIND[type.toLowerCase()] : undefined;
}

/** An `:event-type` that Kiro IDE throws instead of treating as an event. */
export function isKiroExceptionEventType(type) {
    return streamExceptionKind(type) !== undefined;
}

/** Kiro's own retry delay is in milliseconds: header first, then the payload, as in Kiro IDE. */
function kiroRetryAfterMs(headers, data) {
    let value;
    for (const [key, headerValue] of Object.entries(headers || {})) {
        if (key.toLowerCase() === KIRO_RETRY_AFTER_HEADER) { value = Array.isArray(headerValue) ? headerValue[0] : headerValue; break; }
    }
    value ??= data?.retryAfterMilliseconds;
    if (value === undefined || value === null || typeof value === 'string' && !value.trim()) return null;
    const ms = Number(value);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Fill in Retry-After from Kiro's millisecond delay unless upstream sent one. The cooldown reads
 * that header before retryAfterMs, so it waits the rounded-up whole seconds, like the client.
 * kiroRetryDelay records which source won, for the 429 log.
 */
function applyKiroRetryAfter(error, data) {
    const headers = error.response?.headers;
    const upstream = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'retry-after');
    const ms = kiroRetryAfterMs(headers, data);
    if (ms !== null) error.retryAfterMs = ms;
    if (upstream) {
        const value = Array.isArray(upstream[1]) ? upstream[1][0] : upstream[1];
        error.kiroRetryDelay = `Retry-After ${String(value).replace(/[^\w .:,+-]/g, '').slice(0, 40)}`;
    } else if (ms !== null) {
        if (headers) headers['retry-after'] = String(Math.ceil(ms / 1000));
        const fromHeader = Object.keys(headers || {}).some(key => key.toLowerCase() === KIRO_RETRY_AFTER_HEADER);
        error.kiroRetryDelay = `${ms}ms (${fromHeader ? KIRO_RETRY_AFTER_HEADER : 'retryAfterMilliseconds'})`;
    }
}

/** Log-safe reason and retry delay of a Kiro 429, so usage caps can be confirmed from logs. */
export function kiroThrottleLogDetail(error) {
    return `reason: ${kiroErrorReason(error.response?.data) || 'none'}, retry delay: ${error.kiroRetryDelay || 'none'}`;
}

function isNewUserPaused(reason, message) {
    return reason === 'INSUFFICIENT_MODEL_CAPACITY' && KIRO_NEW_USER_PAUSED.test(message);
}

function markAccountThrottle(error, reason) {
    error.status = 429;
    error.kiroAccountRateLimited = true;
    // A service-level throttle may cover every account; it keeps the full switch wait.
    error.kiroAccountScoped = reason !== 'SERVICE_REQUEST_RATE_EXCEEDED';
    error.kiroErrorKind = 'account_throttled';
}

/**
 * In-stream exception frames carry no HTTP status. Map the explicit types to
 * their HTTP equivalents so a deterministic rejection is not replayed with the
 * same body; unknown types (e.g. a plain InternalServerException) keep the replay.
 * A throttle `reason` in the payload is classified exactly as on the HTTP path,
 * and its `retryAfterMilliseconds` stands in for the missing Retry-After header.
 */
export function applyKiroStreamExceptionPolicy(error, exceptionType, reason = '', data = {}) {
    const kind = streamExceptionKind(exceptionType);
    if (kind === 'validation' && KIRO_INPUT_TOO_LONG.test(`${reason} ${error.message}`)) {
        // Same status as the HTTP path, so clients that compact context on 413 still recover.
        Object.assign(error, { status: 413, kiroErrorKind: 'payload_too_large', responseFailureCode: 'KIRO_PAYLOAD_TOO_LARGE',
            isRetryableUpstreamResponseFailure: false, shouldSwitchCredential: false });
    } else if (kind === 'validation') {
        Object.assign(error, { status: 400, kiroErrorKind: 'invalid_request', responseFailureCode: 'KIRO_REQUEST_INVALID',
            isRetryableUpstreamResponseFailure: false, shouldSwitchCredential: false });
    } else if ((kind === 'internal' || kind === 'unavailable') && reason === 'MODEL_TEMPORARILY_UNAVAILABLE') {
        // The HTTP path answers this with 503 and a default Retry-After of 5 seconds.
        Object.assign(error, { status: 503, kiroErrorKind: 'model_unavailable', responseFailureCode: 'KIRO_MODEL_UNAVAILABLE',
            isRetryableUpstreamResponseFailure: false, shouldSwitchCredential: false,
            retryAfterMs: kiroRetryAfterMs(null, data) ?? KIRO_MODEL_UNAVAILABLE_RETRY_MS });
    } else if (kind === 'throttling') {
        const retryAfterMs = kiroRetryAfterMs(null, data);
        if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
        if (KIRO_CAPACITY_THROTTLE_REASON.test(reason) && !isNewUserPaused(reason, error.message)) {
            // Capacity throttles are not evidence that an account is unhealthy.
            Object.assign(error, { status: 429, kiroErrorKind: 'capacity_throttled', responseFailureCode: 'KIRO_CAPACITY_THROTTLED',
                isRetryableUpstreamResponseFailure: false, shouldSwitchCredential: false });
        } else {
            // Otherwise an unclassified 429: switch credential with the usual jitter.
            Object.assign(error, { status: 429, kiroErrorKind: 'throttled', responseFailureCode: 'KIRO_STREAM_THROTTLED',
                isRetryableUpstreamResponseFailure: false, shouldSwitchCredential: true });
            if (KIRO_ACCOUNT_THROTTLE_REASON.test(reason) || isNewUserPaused(reason, error.message)) markAccountThrottle(error, reason);
        }
    }
    return error;
}

/** Upstream `reason` (or Smithy `__type`) of an error body, safe to log. */
export function kiroErrorReason(body) {
    let data = body;
    try { if (typeof body === 'string') data = JSON.parse(body); } catch { return ''; }
    const reason = data?.reason || data?.__type;
    return typeof reason === 'string' ? reason.replace(/[^\w.#:-]/g, '').slice(0, 80) : '';
}

/** Only classify explicit provider errors; unrelated 5xx retain existing failover. */
export function applyKiroErrorPolicy(error, body) {
    const status = Number(error.response?.status ?? error.status);
    let data;
    try { data = typeof body === 'string' ? JSON.parse(body) : body; } catch { /* HTML gateway response */ }
    const reason = data?.reason || data?.__type || '';
    const message = typeof data?.message === 'string' ? data.message : typeof data?.Message === 'string' ? data.Message
        : typeof body === 'string' ? body : '';
    if (status === 429) applyKiroRetryAfter(error, data);
    let result;
    if (status >= 500 && reason === 'MODEL_TEMPORARILY_UNAVAILABLE') {
        result = { status: 503, code: 'KIRO_MODEL_UNAVAILABLE', kind: 'model_unavailable' };
        const headers = error.response?.headers || {};
        if (!Object.keys(headers).some(key => key.toLowerCase() === 'retry-after')) headers['retry-after'] = '5';
        if (error.response) error.response.headers = headers;
    } else if (status === 524 || status >= 500 && /gateway\s*(?:time[ -]?out|timed out)/i.test(message)) {
        result = { status: 504, code: 'KIRO_GATEWAY_TIMEOUT', kind: 'gateway_timeout' };
    } else if (status >= 500 && /(?:invalid (?:request|message)|validationexception|messages?.*(?:must alternate|must start|invalid role|empty array))/i.test(`${reason} ${message}`)) {
        result = { status: 400, code: 'KIRO_REQUEST_INVALID', kind: 'invalid_request' };
    } else if (status === 400 && KIRO_INPUT_TOO_LONG.test(`${reason} ${message}`)) {
        result = { status: 413, code: 'KIRO_PAYLOAD_TOO_LARGE', kind: 'payload_too_large' };
    } else if (status === 429 && (KIRO_ACCOUNT_THROTTLE_REASON.test(reason) || isNewUserPaused(reason, message))) {
        markAccountThrottle(error, reason);
    } else if (status === 429 && KIRO_CAPACITY_THROTTLE_REASON.test(reason)) {
        // Capacity throttles are not evidence that an account is unhealthy.
        result = { status: 429, code: 'KIRO_CAPACITY_THROTTLED', kind: 'capacity_throttled' };
    }
    if (!result) return false;
    const descriptions = {
        model_unavailable: 'The requested Kiro model is temporarily unavailable. Please retry later.',
        gateway_timeout: 'The Kiro upstream gateway timed out.',
        invalid_request: 'Kiro rejected the request format. Check the messages and generation parameters.',
        payload_too_large: 'The request exceeds the Kiro upstream payload limit.',
        capacity_throttled: 'Kiro model capacity is temporarily exhausted. Please retry later.'
    };
    error.message = typeof data?.message === 'string' && data.message.trim()
        ? data.message.trim().slice(0, 2048) : descriptions[result.kind];
    Object.assign(error, { status: result.status, code: result.code, kiroErrorKind: result.kind,
        responseFailureCode: result.code,
        skipErrorCount: true, shouldSwitchCredential: false, isRetryableUpstreamResponseFailure: false });
    if (error.response) error.response.status = result.status;
    return true;
}
