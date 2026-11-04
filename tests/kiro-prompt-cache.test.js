import { jest } from '@jest/globals';
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
import { buildKiroCacheProfile, captureKiroCacheSources } from '../src/providers/claude/kiro-cache-profile.js';
import * as tokenUtils from '../src/utils/token-utils.js';
import { countTextTokens } from '../src/utils/token-utils.js';
import { KiroCacheMeter } from '../src/providers/claude/kiro-cache-meter.js';
import { KIRO_USAGE_DETAILS, resolveKiroCacheUsage, splitKiroCacheUsage } from '../src/providers/claude/kiro-cache-usage.js';

const model = 'claude-sonnet-4.5';
const cc = (ttl = '5m') => ({ type: 'ephemeral', ttl });
const block = (text, marked = false, ttl) => ({ type: 'text', text, ...(marked ? { cache_control: cc(ttl) } : {}) });
const config = { KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: { [model]: 1 } };
function profile(parts = [block('A'.repeat(100), true)], options = {}) {
    const wire = { modelId: model, origin: 'IDE', content: parts.map(part => part.text || '').join('') };
    const payload = { conversationState: { conversationId: options.conversation || 'session',
        currentMessage: { userInputMessage: wire }, ...(options.history ? { history: options.history } : {}) } };
    const source = captureKiroCacheSources([{ wire, content: parts }], {
        messages: [{ role: 'user', content: parts }], cache_control: options.automatic
    });
    return buildKiroCacheProfile(payload, source, { ...config, ...options.config }, value => value.length);
}

describe('deterministic Kiro prefix accounting', () => {
    let now, meter;
    beforeEach(() => { now = 1000; meter = new KiroCacheMeter({ now: () => now }); });
    test('first write, repeated read, and moved breakpoint reuse the longest stored prefix', () => {
        const first = meter.prepare(profile(), 'account-a');
        expect(first).toMatchObject({ covered: 100, read: 0 });
        expect(meter.entries.size).toBe(0);
        first.commit();
        const repeated = meter.prepare(profile(), 'account-a');
        expect(repeated.read).toBe(100);
        const extended = meter.prepare(profile([block('A'.repeat(100)), block('B'.repeat(50), true)]), 'account-a');
        expect(extended).toMatchObject({ covered: 150, read: 100, total: 150 });
        expect(splitKiroCacheUsage(12000, extended)).toMatchObject({ input: 0, creation: 4000, read: 8000 });
    });
    test('a breakpoint inside text does not cache the unmarked tail', () => {
        const plan = meter.prepare(profile([block('A'.repeat(100), true), block('tail'.repeat(25))]), 'account-a');
        expect(splitKiroCacheUsage(12000, plan)).toMatchObject({ input: 6000, creation: 6000, read: 0 });
    });
    test('splitting Unicode text blocks does not change the final actual prefix', () => {
        meter.prepare(profile([block('rocket 🚀', true)]), 'same').commit();
        expect(meter.prepare(profile([block('rocket \uD83D'), block('\uDE80', true)]), 'same').read).toBe(9);
    });
    test('concurrent cold attempts remain cold even when another attempt commits', () => {
        const first = meter.prepare(profile(), 'same');
        const concurrent = meter.prepare(profile(), 'same');
        first.commit();
        expect(concurrent.read).toBe(0);
        concurrent.commit();
        expect(meter.prepare(profile(), 'same').read).toBe(100);
    });
    test('TTL starts at dispatch; slow or abandoned responses cannot create a warm entry', () => {
        const slow = meter.prepare(profile(), 'same');
        now += 300001; slow.commit();
        expect(meter.prepare(profile(), 'same').read).toBe(0);
        const success = meter.prepare(profile(), 'same'); success.commit();
        now += 299999;
        const hit = meter.prepare(profile(), 'same');
        expect(hit.read).toBe(100);
        now += 2; // a failed hit never renewed the old entry
        expect(meter.prepare(profile(), 'same').read).toBe(0);
    });
    test('a successful read renews its own TTL and an old slow request cannot shorten it', () => {
        meter.prepare(profile(), 'same').commit();
        now += 10000;
        const slow = meter.prepare(profile(), 'same');
        now += 10000;
        meter.prepare(profile(), 'same').commit();
        slow.commit();
        now = 316000;
        expect(meter.prepare(profile(), 'same').read).toBe(100);
        now = 321000;
        expect(meter.prepare(profile(), 'same').read).toBe(0);
    });
    test('accounts, sessions and prefix contents are isolated', () => {
        meter.prepare(profile(), 'account-a').commit();
        expect(meter.prepare(profile(), 'account-b').read).toBe(0);
        expect(meter.prepare(profile(undefined, { conversation: 'other-session' }), 'account-a').read).toBe(0);
        expect(meter.prepare(profile([block('changed', true)]), 'account-a').read).toBe(0);
        const changedModel = profile(); changedModel.namespace += '-another-model';
        expect(meter.prepare(changedModel, 'account-a').read).toBe(0);
    });
    test('lookback checks at most twenty block positions', () => {
        meter.prepare(profile(), 'same').commit();
        const grown = n => profile([block('A'.repeat(100)), ...Array.from({ length: n }, (_, i) => block(`b${i};`, i === n - 1))]);
        expect(meter.prepare(grown(19), 'same').read).toBe(100);
        expect(meter.prepare(grown(20), 'same').read).toBe(0);
    });
    test('mixed TTL entries expire independently and creation tiers conserve tokens', () => {
        const p = profile([block('A'.repeat(100), true, '1h'), block('B'.repeat(100), true)]);
        const first = meter.prepare(p, 'same');
        expect(splitKiroCacheUsage(12000, first)).toMatchObject({ creation: 12000, oneHour: 6000, fiveMinute: 6000 });
        first.commit(); now += 300001;
        const next = meter.prepare(p, 'same');
        expect(next.read).toBe(100);
        expect(splitKiroCacheUsage(12000, next)).toMatchObject({ read: 6000, creation: 6000, oneHour: 0, fiveMinute: 6000 });
    });
    test('storage is capped and contains only hashes and numeric metadata', () => {
        for (let i = 0; i < 4; i++) meter.prepare(profile([block(`secret prompt ${i}`, true)]), 'secret-api-key', { capacity: 2 }).commit();
        expect(meter.entries.size).toBe(2);
        expect(JSON.stringify([...meter.entries])).not.toMatch(/secret|prompt|api-key/);
    });
    test.each([
        [[block('a', true, '5m'), block('b', true, '1h')], 'invalid_ttl_order'],
        [[...Array.from({ length: 5 }, () => block('a', true))], 'too_many_breakpoints'],
        [[{ type: 'text', text: 'a', cache_control: { type: 'unknown' } }], 'invalid_cache_control']
    ])('invalid declarations do not fall through to history caching', (parts, reason) => {
        expect(profile(parts)).toMatchObject({ policy: 'explicit', breakpoints: [], reason });
    });
    test('automatic caching follows the last block, and minimum lengths can be overridden', () => {
        expect(profile([block('abc')], { automatic: cc() }).breakpoints).toHaveLength(1);
        expect(profile([block('abc', true)], { config: { KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: { [model]: 100 } } }))
            .toMatchObject({ breakpoints: [], reason: 'below_minimum' });
        expect(profile([block('abc', true)], { config: { KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL: {} } }).reason).toBe('below_minimum');
        expect(profile([block('abc')], { config: { KIRO_PROMPT_CACHE_POLICY: 'explicit' } }).breakpoints).toHaveLength(0);
    });
    test('actual images and tool results participate in prefix identity; dropped marked blocks are rejected', () => {
        const imageProfile = bytes => {
            const wire = { modelId: model, origin: 'IDE', content: 'question', images: [{ format: 'png', source: { bytes } }] };
            const parts = [{ type: 'text', text: 'question' }, { type: 'image', cache_control: cc() }];
            return buildKiroCacheProfile({ conversationState: { conversationId: 'same', currentMessage: { userInputMessage: wire } } },
                captureKiroCacheSources([{ wire, content: parts }], { messages: [{ content: parts }] }), config, value => value.length);
        };
        meter.prepare(imageProfile('image-a'), 'same').commit();
        expect(meter.prepare(imageProfile('image-a'), 'same').read).toBeGreaterThan(0);
        expect(meter.prepare(imageProfile('image-b'), 'same').read).toBe(0);
        const wire = { modelId: model, content: 'tool result inlined', origin: 'IDE' };
        const parts = [{ type: 'tool_result', tool_use_id: 'call', content: 'result', cache_control: cc() }];
        const unmapped = buildKiroCacheProfile({ conversationState: { currentMessage: { userInputMessage: wire } } },
            captureKiroCacheSources([{ wire, content: parts }], { messages: [{ content: parts }] }), config);
        expect(unmapped).toMatchObject({ breakpoints: [], reason: 'unmapped_breakpoint' });
    });
    const build = parts => {
        const wire = { modelId: model, origin: 'IDE', content: parts.map(part => part.text).join('') };
        return buildKiroCacheProfile({ conversationState: { conversationId: 'memo', currentMessage: { userInputMessage: wire } } },
            captureKiroCacheSources([{ wire, content: parts }], { messages: [{ content: parts }] }), config);
    };
    test('a tokenizer failure is not memoized as the block count', () => {
        const text = 'memo fallback check '.repeat(30);
        expect(countTextTokens(text)).not.toBe(Math.ceil(text.length / 4));
        const failure = jest.spyOn(tokenUtils, 'exactTextTokens').mockReturnValueOnce(null);
        try {
            expect(build([block(text, true)]).blocks[0].tokens).toBe(Math.ceil(text.length / 4));
        } finally {
            failure.mockRestore();
        }
        expect(build([block(text, true)]).blocks[0].tokens).toBe(countTextTokens(text));
    });
    test('memoized default token counts match direct tokenization on repeated and distinct blocks', () => {
        const first = 'function a() { return 1; }\n中文说明🟢 '.repeat(40);
        const second = 'const b = [1, 2, 3].map(x => x * 2);\n'.repeat(40);
        const parts = [block(first, true), block(second, true)];
        const expected = [countTextTokens(first), countTextTokens(first) + countTextTokens(second)];
        for (let round = 0; round < 2; round++) expect(build(parts).blocks.map(item => item.tokens)).toEqual(expected);
        expect(build([block(second, true)]).blocks.map(item => item.tokens)).toEqual([countTextTokens(second)]);
    });
});

describe('Kiro final usage resolution', () => {
    const plan = { policy: 'explicit', reason: null, total: 120, covered: 100, read: 80,
        creationTiers: [{ tokens: 100, ttlMs: 300000 }] };
    const resolve = extra => resolveKiroCacheUsage({ inputTokens: 12000, outputTokens: 500, plan, mode: 'estimate', ...extra });
    test('splits total into uncached/read/write and keeps provenance off the wire', () => {
        const { usage, details } = resolve();
        expect(usage).toMatchObject({ input_tokens: 2000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 });
        expect(details.totalInputTokens).toBe(12000);
        expect(usage[KIRO_USAGE_DETAILS]).toBe(details);
        expect(JSON.stringify(usage)).not.toMatch(/estimated|sources|totalInputTokens/);
    });
    test('complete native usage and native zeros override every estimate', () => {
        const nativeUsage = { input_tokens: 12000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        const result = resolve({ nativeUsage });
        expect(result.usage).toMatchObject(nativeUsage);
        expect(result.details.totalSource).toBe('provider');
    });
    test('partial native values consume the same total before filling missing cache fields', () => {
        const { usage, details } = resolve({ nativeUsage: { input_tokens: 3000, cache_read_input_tokens: 0 } });
        expect(usage).toMatchObject({ input_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 });
        expect(details.totalInputTokens).toBe(5000); // provider uncached count wins over the larger local estimate
        expect(details.sources.cache_read_input_tokens).toBe('provider');
        expect(details.sources.cache_creation_input_tokens).toBe('estimated');
    });
    describe.each(['off', 'observe', 'estimate'])('authoritative totals in %s mode', mode => {
        test.each(['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])('derive only the missing %s from provider counts', missing => {
            const expected = { input_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 9000 };
            const nativeUsage = { ...expected };
            delete nativeUsage[missing];
            const { usage, details } = resolve({ mode, nativeUsage, totalSource: 'provider_total',
                plan: { ...plan, covered: 20, read: 0, creationTiers: [{ tokens: 20, ttlMs: 3600000 }] } });
            expect(usage).toMatchObject(expected);
            expect(usage.cache_creation).toBeUndefined(); // arithmetic cannot establish a TTL
            expect(details).toMatchObject({ totalInputTokens: 12000, totalSource: 'provider',
                sources: { input_tokens: 'provider', cache_read_input_tokens: 'provider', cache_creation_input_tokens: 'provider' } });
            expect(nativeUsage).not.toHaveProperty(missing);
        });
        test('conflicting counts do not produce a negative inferred field', () => {
            const { usage, details } = resolve({ mode, inputTokens: 100,
                nativeUsage: { input_tokens: 3000, cache_read_input_tokens: 0 }, totalSource: 'provider_total' });
            expect(usage).toMatchObject({ input_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
            expect(details.totalSource).toBe('mixed');
        });
        test('zero is a valid authoritative total', () => {
            const { usage, details } = resolve({ mode, inputTokens: 0,
                nativeUsage: { input_tokens: 0, cache_read_input_tokens: 0 }, totalSource: 'provider_total' });
            expect(usage.cache_creation_input_tokens).toBe(0);
            expect(details.sources.cache_creation_input_tokens).toBe('provider');
        });
    });
    test('a native read larger than the estimate is preserved and diagnosed', () => {
        const { usage, details } = resolve({ inputTokens: 10, nativeUsage: { cache_read_input_tokens: 30 } });
        expect(usage).toMatchObject({ input_tokens: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 });
        expect(details.reason).toBe('provider_exceeds_estimated_total');
    });
    test.each(['off', 'observe'])('%s leaves outward cache usage unchanged', mode => {
        const { usage, details } = resolve({ mode });
        expect(usage).toMatchObject({ input_tokens: 12000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
        expect(details.sources.cache_read_input_tokens).toBe('unavailable');
        if (mode === 'observe') expect(details.observed.read).toBe(8000);
    });
    test('rounding and zero totals never create negative or duplicated tokens', () => {
        for (const total of [0, 1, 7, 113, 12001]) {
            const { usage } = resolve({ inputTokens: total });
            expect(usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens).toBe(total);
            expect(Object.values(usage).filter(value => typeof value === 'number').every(value => value >= 0 && Number.isInteger(value))).toBe(true);
        }
    });
});
