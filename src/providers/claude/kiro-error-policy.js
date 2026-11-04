/** Only classify explicit provider errors; unrelated 5xx retain existing failover. */
export function applyKiroErrorPolicy(error, body) {
    const status = Number(error.response?.status ?? error.status);
    let data;
    try { data = typeof body === 'string' ? JSON.parse(body) : body; } catch { /* HTML gateway response */ }
    const reason = data?.reason || data?.__type || '';
    const message = typeof data?.message === 'string' ? data.message : typeof body === 'string' ? body : '';
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
    } else if (status === 400 && /CONTENT_LENGTH_EXCEEDS_THRESHOLD/.test(`${reason} ${message}`)) {
        result = { status: 413, code: 'KIRO_PAYLOAD_TOO_LARGE', kind: 'payload_too_large' };
    } else if (status === 429 && /^(?:SERVICE_REQUEST_RATE_EXCEEDED|USER_REQUEST_RATE_EXCEEDED|CREDIT_CONSUMPTION_RATE_EXCEEDED|ACCOUNT_RATE_LIMIT_EXCEEDED)$/.test(reason)) {
        error.status = 429;
        error.kiroAccountRateLimited = true;
        error.kiroErrorKind = 'account_throttled';
    } else if (status === 429 && /^(?:CAPACITY_EXCEEDED|INSUFFICIENT_MODEL_CAPACITY|MODEL_TEMPORARILY_UNAVAILABLE)$/.test(reason)) {
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
