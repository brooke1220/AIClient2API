import { createHash } from 'node:crypto';

export function kiroCredentialFingerprint(accessToken) {
    return typeof accessToken === 'string' && accessToken
        ? createHash('sha256').update(accessToken).digest('hex') : undefined;
}

function positiveNumber(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getKiroRefreshAheadMs(config = {}) {
    const ahead = positiveNumber(config.KIRO_REFRESH_AHEAD_MINUTES, 10) * 60000;
    const jitter = Number.isFinite(config.KIRO_REFRESH_JITTER_MS) && config.KIRO_REFRESH_JITTER_MS >= 0
        ? config.KIRO_REFRESH_JITTER_MS : 30000;
    // The same credential gets the same window in the cron and request paths.
    const identity = config.KIRO_OAUTH_CREDS_FILE_PATH || config.uuid || '';
    const fraction = createHash('sha256').update(identity).digest().readUInt32BE(0) / 0xffffffff;
    return ahead + Math.floor(fraction * jitter);
}

export function kiroRefreshError(message, code = 'KIRO_CREDENTIAL_REFRESH_FAILED', cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = code;
    error.status = 503;
    error.skipErrorCount = true;
    error.shouldSwitchCredential = false;
    return error;
}

/** Cancelling a caller's wait must not cancel the shared credential rotation. */
export async function waitForKiroRefresh(operation, { signal, timeoutMs } = {}) {
    const shared = Promise.resolve(operation);
    shared.catch(() => {});
    signal?.throwIfAborted();
    let timer, onAbort;
    try {
        return await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(kiroRefreshError(
                'Timed out waiting for Kiro credential refresh', 'KIRO_CREDENTIAL_REFRESH_TIMEOUT'
            )), Math.min(positiveNumber(timeoutMs, 15000), 2147483647));
            onAbort = () => reject(signal.reason);
            signal?.addEventListener('abort', onAbort, { once: true });
            shared.then(resolve, reject);
            if (signal?.aborted) onAbort();
        });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
