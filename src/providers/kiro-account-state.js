const KIRO_PROVIDER = 'claude-kiro-oauth';

export function isKiroProviderType(providerType) {
    return typeof providerType === 'string' && (providerType === KIRO_PROVIDER || providerType.startsWith(`${KIRO_PROVIDER}-`));
}

export function isKiroSuspensionMessage(message) {
    const text = String(message || '').toLowerCase().replace(/[_-]+/g, ' ');
    return /\btemporarily(?:\s+is)?\s+suspended\b|\b(?:account|user(?:\s+id)?)\s+(?:(?:is|was|has\s+been)\s+)?suspended\b/.test(text);
}

export function isKiroAccountSuspended(config) {
    return config?.kiroAccountSuspended === true || isKiroSuspensionMessage(config?.lastErrorMessage);
}

/** The pool config is authoritative; request/adapter config may be an older copy. */
export function getKiroAccountUnavailableError(providerType, config, options = {}) {
    if (!isKiroProviderType(providerType) || !config) return null;
    const { allowUnhealthy = false, allowNeedsRefresh = false, manualRecovery = false, now = Date.now() } = options;
    const recoveryAt = new Date(config.scheduledRecoveryTime || 0).getTime();
    let reason;
    let status = 429;
    if (config.isDisabled === true) {
        reason = 'disabled';
        status = 403;
    } else if (!manualRecovery && isKiroAccountSuspended(config)) {
        reason = 'suspended; manual recovery is required';
        status = 403;
    } else if (!allowNeedsRefresh && config.needsRefresh === true) {
        reason = 'awaiting credential refresh';
    } else if (!manualRecovery && recoveryAt > now) {
        reason = 'cooling down until the scheduled recovery time';
    } else if (!allowUnhealthy && config.isHealthy === false) {
        reason = 'unhealthy';
    }
    if (!reason) return null;
    const error = new Error(`Kiro account is unavailable: ${reason}`);
    error.code = 'KIRO_ACCOUNT_UNAVAILABLE';
    error.status = status;
    error.isKiroAccountUnavailable = true;
    error.skipErrorCount = true;
    error.shouldSwitchCredential = false;
    if (recoveryAt > now) error.retryAfterMs = recoveryAt - now;
    return error;
}
