const NODE_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:']);

function invalidNodeProxyUrl() {
    const error = new Error('Node proxy URL must be a valid HTTP, HTTPS or SOCKS5 URL with a hostname.');
    error.statusCode = 400;
    error.code = 'INVALID_NODE_PROXY_URL';
    return error;
}

/** A missing or blank node proxy inherits the existing global proxy settings. */
export function normalizeNodeProxyUrl(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw invalidNodeProxyUrl();

    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!/^[a-z][a-z\d+.-]*:\/\/[^/?#]/i.test(trimmed) || /[\s\\]/.test(trimmed)) {
        throw invalidNodeProxyUrl();
    }

    try {
        const url = new URL(trimmed);
        if (!NODE_PROXY_PROTOCOLS.has(url.protocol) || !url.hostname) {
            throw invalidNodeProxyUrl();
        }
        // Agents decode credentials before connecting; reject bad escapes at
        // save time rather than accepting an address the agent cannot use.
        decodeURIComponent(url.username);
        decodeURIComponent(url.password);
        return trimmed;
    } catch {
        throw invalidNodeProxyUrl();
    }
}

/** Return an address suitable for logs without exposing proxy credentials. */
export function redactProxyUrl(value) {
    if (value === undefined || value === null || value === '') return '';
    try {
        const url = new URL(String(value));
        if (url.username) url.username = '***';
        if (url.password) url.password = '***';
        return url.toString();
    } catch {
        return '[invalid proxy URL]';
    }
}
