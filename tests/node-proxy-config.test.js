import { normalizeNodeProxyUrl, redactProxyUrl } from '../src/utils/node-proxy-config.js';
import { normalizeProviderConfigFields } from '../src/utils/provider-config-normalizer.js';

describe('node proxy configuration', () => {
    test.each([undefined, null, '', ' \n\t '])('inherits for an empty value: %p', value => {
        expect(normalizeNodeProxyUrl(value)).toBeNull();
    });

    test.each([
        'http://127.0.0.1:7890',
        'https://user:password@proxy.example:443',
        'socks5://user:p%40ss@[::1]:1080'
    ])('trims and accepts a supported proxy: %s', value => {
        expect(normalizeNodeProxyUrl(` ${value} `)).toBe(value);
    });

    test.each([
        123, false, [], {}, 'proxy.example:8080', 'http:proxy.example',
        'ftp://proxy.example', 'socks4://proxy.example:1080', 'http://',
        'http://:8080', 'http:///proxy.example', 'http://proxy\\example',
        'https://proxy.example:99999', 'http://bad host:80',
        'https://user:private-secret@:443', 'socks5://user:%zz@proxy.example:1080',
        'http://%zz:password@proxy.example:8080'
    ])('rejects unsupported or malformed values without echoing them: %p', value => {
        let error;
        try { normalizeNodeProxyUrl(value); } catch (caught) { error = caught; }
        expect(error).toMatchObject({ statusCode: 400, code: 'INVALID_NODE_PROXY_URL' });
        expect(error.message).not.toContain('private-secret');
    });

    test('normalizes only explicitly supplied node fields and preserves existing typed fields', () => {
        expect(normalizeProviderConfigFields({ customName: 'legacy' })).toEqual({ customName: 'legacy' });
        expect(normalizeProviderConfigFields({
            NODE_PROXY_URL: '  ',
            PROXY_ENABLED_PROVIDERS: '["claude-kiro-oauth"]',
            TLS_SIDECAR_ENABLED: 'true'
        })).toEqual({
            NODE_PROXY_URL: null,
            PROXY_ENABLED_PROVIDERS: ['claude-kiro-oauth'],
            TLS_SIDECAR_ENABLED: true
        });
    });

    test('redacts both username and password and hides malformed values', () => {
        const redacted = redactProxyUrl('socks5://private-user:private-secret@proxy.example:1080');
        expect(redacted).toBe('socks5://***:***@proxy.example:1080');
        expect(redacted).not.toMatch(/private-user|private-secret/);
        expect(redactProxyUrl('http://private-user:private-secret@')).toBe('[invalid proxy URL]');
        expect(redactProxyUrl(null)).toBe('');
    });
});
