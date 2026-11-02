import { cloneConfig, mergeConfig } from '../src/utils/config-merge.js';
import { acquireProviderSlot } from '../src/providers/provider-slot-lease.js';

describe('configuration isolation and merge compatibility', () => {
    test('provider values override defaults while nested objects merge and arrays concatenate', () => {
        const base = {
            MODEL_PROVIDER: 'claude-kiro-oauth',
            TLS_SIDECAR_ENABLED: true,
            NODE_PROXY_URL: 'http://global-proxy:8080',
            retry: { max: 3, delays: [100], nested: { retained: true } },
            providers: [{ name: 'global' }]
        };
        const override = {
            uuid: 'account-a', TLS_SIDECAR_ENABLED: false, NODE_PROXY_URL: null,
            retry: { max: 0, delays: [200], nested: { added: true } },
            providers: [{ name: 'account' }]
        };

        const merged = mergeConfig(base, override);

        expect(merged).toEqual({
            MODEL_PROVIDER: 'claude-kiro-oauth', uuid: 'account-a',
            TLS_SIDECAR_ENABLED: false, NODE_PROXY_URL: null,
            retry: { max: 0, delays: [100, 200], nested: { retained: true, added: true } },
            providers: [{ name: 'global' }, { name: 'account' }]
        });
        merged.retry.nested.retained = false;
        merged.providers[0].name = 'changed-global';
        merged.providers[1].name = 'changed-account';
        expect(base.retry.nested.retained).toBe(true);
        expect(base.providers).toEqual([{ name: 'global' }]);
        expect(override.providers).toEqual([{ name: 'account' }]);
    });

    test.each([
        [{ a: 1 }, [2], [2]],
        [[1], { b: 2 }, { b: 2 }],
        [{ a: 1 }, null, null],
        [[1], false, false],
        [{ a: 1 }, undefined, undefined],
        [true, { a: 1 }, { a: 1 }]
    ])('replaces incompatible values: %p -> %p', (base, override, expected) => {
        expect(mergeConfig({ value: base }, { value: override })).toEqual({ value: expected });
    });

    test('request copies isolate nested provider pools and retain callbacks and runtime values', () => {
        const callback = () => 'callback';
        const runtime = { date: new Date(), pattern: /kiro/i, url: new URL('https://example.test'), signal: new AbortController().signal };
        const config = { providerPools: { kiro: [{ uuid: 'account-a' }] }, callback, ...runtime };

        const firstRequest = cloneConfig(config);
        const secondRequest = cloneConfig(config);
        firstRequest.providerPools.kiro[0].uuid = 'changed';

        expect(config.providerPools.kiro[0].uuid).toBe('account-a');
        expect(secondRequest.providerPools.kiro[0].uuid).toBe('account-a');
        expect(firstRequest.callback).toBe(callback);
        for (const [key, value] of Object.entries(runtime)) expect(firstRequest[key]).toBe(value);
    });

    test('copies enumerable symbols but does not copy an account slot lease', async () => {
        const symbol = Symbol('plugin-config');
        const provider = { config: { uuid: 'account-a', concurrencyLimit: 1 }, state: { activeCount: 0, waitingCount: 0, queue: [] } };
        const selected = await acquireProviderSlot(provider);
        selected[symbol] = { enabled: true };
        const lease = selected._slotLease;
        try {
            const merged = mergeConfig({ MODEL_PROVIDER: 'claude-kiro-oauth' }, selected);
            expect(merged[symbol]).toEqual({ enabled: true });
            expect(merged[symbol]).not.toBe(selected[symbol]);
            expect(Object.hasOwn(merged, '_slotLease')).toBe(false);
            expect(lease.released).toBe(false);
        } finally {
            lease.release();
        }
        expect(lease.released).toBe(true);
        expect(provider.state.activeCount).toBe(0);
    });
});

describe('configuration prototype protection', () => {
    const payload = () => JSON.parse('{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"isAdmin":true}},"prototype":{"isAdmin":true},"safe":1}');

    function assertClean(value) {
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        for (const key of ['__proto__', 'constructor', 'prototype']) expect(Object.hasOwn(value, key)).toBe(false);
        expect(value.isAdmin).toBeUndefined();
        expect({}.isAdmin).toBeUndefined();
    }

    test.each(['base', 'override', 'both'])('filters dangerous keys from the %s input at every depth', input => {
        const malicious = { ...payload(), nested: payload(), list: [payload()] };
        const base = input === 'override' ? { retained: true, nested: { retained: true }, list: [] } : malicious;
        const override = input === 'base' ? { added: true, nested: { added: true }, list: [] } : malicious;

        const merged = mergeConfig(base, override);

        assertClean(merged);
        assertClean(merged.nested);
        merged.list.forEach(assertClean);
        expect(merged.safe).toBe(1);
        expect(merged.nested.safe).toBe(1);
        // The input remains untouched; sanitizing must not mutate shared settings.
        expect(Object.hasOwn(malicious, '__proto__')).toBe(true);
    });

    test('request cloning filters unsafe fields in newly introduced objects and arrays', () => {
        const config = { nested: payload(), list: [[payload()]] };
        const cloned = cloneConfig(config);
        assertClean(cloned.nested);
        assertClean(cloned.list[0][0]);
    });

    test('drops inherited settings and accepts null-prototype configuration records', () => {
        const inherited = Object.assign(Object.create({ isAdmin: true }), { own: { enabled: true } });
        const nullPrototype = Object.assign(Object.create(null), { added: { enabled: true } });
        const merged = mergeConfig(inherited, nullPrototype);
        assertClean(merged);
        expect(merged).toEqual({ own: { enabled: true }, added: { enabled: true } });
        expect(merged.own).not.toBe(inherited.own);
    });
});
