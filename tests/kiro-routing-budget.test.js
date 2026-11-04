import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import { KiroSessionAffinity, createKiroSessionContext, kiroClientScope } from '../src/providers/claude/kiro-session.js';
import { KiroAccountBudget, kiroAccountBudget, kiroBudgetKey, kiroBudgetKeyForConfig } from '../src/providers/claude/kiro-account-budget.js';
import { kiroModelCapabilityScope } from '../src/providers/claude/kiro-model-cache.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { collect, frame, model, request, service, text, bounded, tick } from './helpers/kiro-safety-fixtures.js';
import logger from '../src/utils/logger.js';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';

const TYPE = 'claude-kiro-oauth';
class MemoryPool extends ProviderPoolManager { _debouncedSave() {} _log() {} _logHealthStatusChange() {} }
const pool = (globalConfig = {}) => new MemoryPool({ [TYPE]: [
    { uuid: 'a', isHealthy: true, concurrencyLimit: 1, KIRO_OAUTH_CREDS_FILE_PATH: '/mock/account-a.json' },
    { uuid: 'b', isHealthy: true, concurrencyLimit: 1, KIRO_OAUTH_CREDS_FILE_PATH: '/mock/account-b.json' }
] }, { globalConfig });

describe('Kiro session identity and soft account affinity', () => {
    test('explicit session metadata is stable across turns and scoped by client key', () => {
        const a = createKiroSessionContext({ ...request(), metadata: { user_id: '{"session_id":"session-a"}' } }, 'tenant-a');
        const b = createKiroSessionContext({ messages: [{ role: 'user', content: 'next turn' }], metadata: { user_id: 'user_abc_session_session-a' } }, 'tenant-a');
        expect(a).toEqual(b);
        expect(a).not.toEqual(createKiroSessionContext({ ...request(), metadata: { session_id: 'session-a' } }, 'tenant-b'));
        expect(a.conversationId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        expect(kiroClientScope({ headers: { authorization: 'Bearer secret' } })).toBe(kiroClientScope({ headers: { 'x-api-key': 'secret' } }));
        expect(kiroClientScope({ headers: { 'x-api-key': 'secret' } })).not.toContain('secret');
        expect(kiroClientScope({ headers: { authorization: 'Bearer ignored', 'x-api-key': 'secret' } }, { REQUIRED_API_KEY: 'secret' }))
            .toBe(kiroClientScope({ headers: { 'x-api-key': 'secret' } }));
        expect(createKiroSessionContext({ messages: 'malformed' })).toBeNull();
    });

    test('fallback identity includes the first user and system, and does not change on appended turns', async () => {
        const first = request();
        const next = { messages: [...first.messages, { role: 'assistant', content: 'a' }, { role: 'user', content: 'next' }] };
        expect(createKiroSessionContext(first)).toEqual(createKiroSessionContext(next));
        expect(createKiroSessionContext(first)).not.toEqual(createKiroSessionContext({ ...first, system: 'different' }));
        const responseInput = [{ role: 'system', content: 'one' }, { role: 'user', content: 'hello' }];
        expect(createKiroSessionContext({ input: responseInput })).not.toEqual(createKiroSessionContext({ input: [
            { role: 'system', content: 'two' }, responseInput[1]
        ] }));
        const backend = service(); backend.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
        const a = await backend.buildCodewhispererRequest(first.messages, model);
        const b = await backend.buildCodewhispererRequest(next.messages, model);
        expect(a.conversationState.conversationId).toBe(b.conversationState.conversationId);
    });

    test('bindings expire and storage remains bounded', () => {
        const affinity = new KiroSessionAffinity({ maxEntries: 2, ttlMs: 10 });
        const state = {};
        affinity.bind('one', state, 0); affinity.bind('two', {}, 1); affinity.bind('three', {}, 2);
        expect(affinity.get('one', 3)).toBeNull();
        expect(affinity.entries.size).toBe(2);
        expect(affinity.get('two', 11)).toBeNull();
    });

    test('selection alone does not bind; acceptance binds to account state across UUID rotation', async () => {
        const manager = pool(); const session = createKiroSessionContext(request(), 'tenant');
        const a = await manager.selectProvider(TYPE, model, { kiroSession: session });
        const b = await manager.selectProvider(TYPE, model, { kiroSession: session });
        expect(a.uuid).not.toBe(b.uuid);
        const accept = manager.captureKiroSessionBinding(TYPE, a.uuid, session.key);
        const rotated = manager.refreshProviderUuid(TYPE, a);
        accept();
        expect((await manager.selectProvider(TYPE, model, { kiroSession: session })).uuid).toBe(rotated);
    });

    test.each(['disabled', 'busy', 'refresh', 'cooldown', 'excluded', 'model'])('affinity yields to %s and preserves failover', async change => {
        const manager = pool(); const session = createKiroSessionContext(request(), 'tenant');
        manager.captureKiroSessionBinding(TYPE, 'a', session.key)();
        const a = manager.providerStatus[TYPE][0];
        if (change === 'disabled') a.config.isDisabled = true;
        if (change === 'busy') a.state.activeCount = 1;
        if (change === 'refresh') a.config.needsRefresh = true;
        if (change === 'cooldown') a.config.scheduledRecoveryTime = new Date(Date.now() + 60000).toISOString();
        if (change === 'model') a.config.notSupportedModels = [model];
        expect((await manager.selectProvider(TYPE, model, { kiroSession: session,
            ...(change === 'excluded' ? { excludeUuids: ['a'] } : {}) })).uuid).toBe('b');
    });

    test('only fresh, successfully discovered capabilities narrow account eligibility', async () => {
        const manager = pool({ KIRO_DYNAMIC_MODELS: true });
        manager.updateKiroModelCapabilities(TYPE, 'a', ['other-model'], 60000);
        expect((await manager.selectProvider(TYPE, model)).uuid).toBe('b');
        manager.providerStatus[TYPE][0].state._kiroDiscoveredModels.expiresAt = 0;
        manager.providerStatus[TYPE][1].config.isDisabled = true;
        expect((await manager.selectProvider(TYPE, model)).uuid).toBe('a');
    });
});

describe('Kiro per-account rate budgets', () => {
    test('readiness observes interval and minute expiration without reserving or mutating state', async () => {
        let now = 0;
        const budget = new KiroAccountBudget({ now: () => now });
        const config = { KIRO_ACCOUNT_MIN_INTERVAL_MS: 50, KIRO_ACCOUNT_REQUESTS_PER_MINUTE: 1 };
        expect(budget.getWaitMs('missing', config)).toBe(0);
        expect(budget.accounts.size).toBe(0);
        await budget.reserve('a', config);
        const state = budget.accounts.get('a'), starts = [...state.starts];
        expect(budget.getWaitMs('a', config)).toBe(60000);
        expect(budget.getWaitMs('a', { KIRO_ACCOUNT_MIN_INTERVAL_MS: 50 })).toBe(50);
        now = 50;
        expect(budget.getWaitMs('a', { KIRO_ACCOUNT_MIN_INTERVAL_MS: 50 })).toBe(0);
        now = 60000;
        expect(budget.getWaitMs('a', config)).toBe(0);
        expect(state.starts).toEqual(starts);
        expect(state.last).toBe(0);
    });

    test('pending starts are not ready, while disabled and invalid limits remain ready', async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const budget = new KiroAccountBudget();
        const config = { KIRO_ACCOUNT_MIN_INTERVAL_MS: 50 };
        const pending = budget.reserve('a', config, undefined, () => gate);
        await tick();
        expect(budget.getWaitMs('a', config)).toBe(Infinity);
        for (const invalid of [0, -1, 1.5, 'invalid', Infinity]) {
            expect(budget.getWaitMs('a', { KIRO_ACCOUNT_MIN_INTERVAL_MS: invalid, KIRO_ACCOUNT_REQUESTS_PER_MINUTE: invalid })).toBe(0);
        }
        expect(budget.getWaitMs('a', { KIRO_ACCOUNT_MIN_INTERVAL_MS: 2147483648 })).toBe(0);
        release(); await pending;
    });

    test('start times are recorded after the global gate, without blocking another account', async () => {
        let now = 0, release;
        const budget = new KiroAccountBudget({ now: () => now, wait: async ms => { now += ms; } });
        const gate = new Promise(resolve => { release = resolve; });
        const config = { KIRO_ACCOUNT_MIN_INTERVAL_MS: 50 };
        const first = budget.reserve('a', config, undefined, () => gate);
        await tick();
        await bounded(budget.reserve('b', config));
        expect(budget.accounts.get('b').last).toBe(0);
        now = 1000; release(); await bounded(first);
        expect(budget.accounts.get('a').last).toBe(1000);
        await budget.reserve('a', config);
        expect(now).toBe(1050);
    });

    test('minimum intervals and sliding minute budgets apply to one account independently', async () => {
        let now = 0;
        const wait = jest.fn(async ms => { now += ms; });
        const budget = new KiroAccountBudget({ now: () => now, wait });
        const config = { KIRO_ACCOUNT_MIN_INTERVAL_MS: 50, KIRO_ACCOUNT_REQUESTS_PER_MINUTE: 2 };
        await budget.reserve('a', config); await budget.reserve('a', config);
        expect(now).toBe(50);
        await budget.reserve('b', config);
        expect(wait).toHaveBeenCalledTimes(1);
        await budget.reserve('a', config);
        expect(now).toBe(60000);
        expect(budget.accounts.get('a').starts).toEqual([50, 60000]);
    });

    test('cancelled reservations return promptly, never consume capacity, and do not poison following work', async () => {
        const budget = new KiroAccountBudget();
        const config = { KIRO_ACCOUNT_MIN_INTERVAL_MS: 60000 };
        await budget.reserve('a', config);
        const before = budget.accounts.get('a').last;
        const controller = new AbortController();
        const pending = budget.reserve('a', config, controller.signal);
        await tick(); controller.abort();
        await expect(bounded(pending)).rejects.toThrow(/abort/i);
        expect(budget.accounts.get('a').last).toBe(before);
        await bounded(budget.reserve('b', config));
        await bounded(budget.reserve('a', {}));
    });
});

describe('Kiro budget identity and rate-aware soft affinity', () => {
    beforeEach(() => {
        kiroAccountBudget.accounts.clear();
        jest.spyOn(kiroAccountBudget, 'now').mockReturnValue(0);
        jest.replaceProperty(process, 'env', { ...process.env, KIRO_API_KEY: '' });
    });
    afterEach(() => { kiroAccountBudget.accounts.clear(); jest.restoreAllMocks(); });

    test.each([
        {}, { KIRO_API_KEY: 'ksk_test' }, { KIRO_OAUTH_CREDS_FILE_PATH: './configs/a.json' },
        { KIRO_OAUTH_CREDS_DIR_PATH: './configs/kiro-test' },
        { KIRO_OAUTH_CREDS_BASE64: Buffer.from('{"accessToken":"test"}').toString('base64'), KIRO_OAUTH_CREDS_FILE_PATH: '/mock/ignored.json' },
        { KIRO_OAUTH_CREDS_BASE64: 'invalid-base64', KIRO_OAUTH_CREDS_FILE_PATH: '/mock/ignored.json' }
    ])('selection and the real constructor share the same credential identity: %j', config => {
        expect(kiroBudgetKey(new KiroApiService(config))).toBe(kiroBudgetKeyForConfig(config));
        expect(kiroBudgetKeyForConfig({ ...config, uuid: 'before' })).toBe(kiroBudgetKeyForConfig({ ...config, uuid: 'after' }));
    });
    test('default paths, normalized relative paths, environment API keys and Base64 accounts have stable identities', () => {
        expect(kiroBudgetKeyForConfig({})).toBe(kiroBudgetKeyForConfig({
            KIRO_OAUTH_CREDS_FILE_PATH: path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json')
        }));
        expect(kiroBudgetKeyForConfig({ KIRO_OAUTH_CREDS_FILE_PATH: './configs/a.json' })).toBe(
            kiroBudgetKeyForConfig({ KIRO_OAUTH_CREDS_FILE_PATH: path.resolve('configs/a.json') }));
        expect(kiroBudgetKeyForConfig({ KIRO_OAUTH_CREDS_BASE64: Buffer.from('{"id":1}').toString('base64') })).not.toBe(
            kiroBudgetKeyForConfig({ KIRO_OAUTH_CREDS_BASE64: Buffer.from('{"id":2}').toString('base64') }));
        process.env.KIRO_API_KEY = 'ksk_env';
        expect(kiroBudgetKey(new KiroApiService({}))).toBe(kiroBudgetKeyForConfig({ KIRO_API_KEY: 'ksk_env' }));
    });

    test.each([{ KIRO_ACCOUNT_REQUESTS_PER_MINUTE: 1 }, { KIRO_ACCOUNT_MIN_INTERVAL_MS: 1000 }])('a bound account yields to an idle account with ready rate budget: %j', async config => {
        const manager = pool(config), session = createKiroSessionContext(request());
        manager.captureKiroSessionBinding(TYPE, 'a', session.key)();
        await kiroAccountBudget.reserve(kiroBudgetKeyForConfig(manager.providerStatus[TYPE][0].config), config);
        expect((await manager.selectProvider(TYPE, model, { kiroSession: session })).uuid).toBe('b');
        expect(kiroAccountBudget.accounts.size).toBe(1); // selection never reserves another start
    });
    test('a ready bound account retains affinity, including node overrides of global limits', async () => {
        const config = { KIRO_ACCOUNT_REQUESTS_PER_MINUTE: 1 };
        const manager = pool(config), session = createKiroSessionContext(request());
        manager.captureKiroSessionBinding(TYPE, 'a', session.key)();
        const a = manager.providerStatus[TYPE][0];
        await kiroAccountBudget.reserve(kiroBudgetKeyForConfig(a.config), config);
        a.config.KIRO_ACCOUNT_REQUESTS_PER_MINUTE = 0;
        expect((await manager.selectProvider(TYPE, model, { kiroSession: session })).uuid).toBe('a');
    });
    test.each(['disabled', 'busy', 'queued', 'rate-limited'])('existing selection remains available when the alternative is %s', async reason => {
        const config = { KIRO_ACCOUNT_REQUESTS_PER_MINUTE: 1 };
        const manager = pool(config), session = createKiroSessionContext(request());
        manager.captureKiroSessionBinding(TYPE, 'a', session.key)();
        const [a, b] = manager.providerStatus[TYPE];
        await kiroAccountBudget.reserve(kiroBudgetKeyForConfig(a.config), config);
        if (reason === 'disabled') b.config.isDisabled = true;
        if (reason === 'busy') b.state.activeCount = 1;
        if (reason === 'queued') b.state.waitingCount = 1;
        if (reason === 'rate-limited') await kiroAccountBudget.reserve(kiroBudgetKeyForConfig(b.config), config);
        expect((await manager.selectProvider(TYPE, model, { kiroSession: session })).uuid).toBe('a');
    });
});

describe('Kiro discovered capability configuration scope', () => {
    test.each([
        ['KIRO_OAUTH_CREDS_FILE_PATH', '/mock/replacement.json'],
        ['KIRO_OAUTH_CREDS_BASE64', Buffer.from('{"accessToken":"replacement"}').toString('base64')],
        ['KIRO_API_KEY', 'ksk_replacement'], ['KIRO_MODELS_URL', 'https://other.invalid/models'],
        ['KIRO_BASE_URL', 'https://other.invalid/generate']
    ])('changing %s clears obsolete models and preserves active slots', async (field, value) => {
        const manager = pool({ KIRO_DYNAMIC_MODELS: true });
        const [a, b] = manager.providerStatus[TYPE]; b.config.isDisabled = true;
        a.state.activeCount = 1;
        manager.updateKiroModelCapabilities(TYPE, 'a', ['old-model'], 60000);
        manager.providerPools[TYPE][0] = { ...a.config, [field]: value };
        manager.initializeProviderStatus(true);
        expect(manager.providerStatus[TYPE][0].state).toBe(a.state);
        expect(a.state.activeCount).toBe(1);
        expect(a.state._kiroDiscoveredModels).toBeUndefined();
        expect((await manager.selectProvider(TYPE, model)).uuid).toBe('a');
    });
    test('unchanged configuration and UUID rotation preserve valid capabilities', async () => {
        const manager = pool({ KIRO_DYNAMIC_MODELS: true });
        manager.updateKiroModelCapabilities(TYPE, 'a', ['old-model'], 60000);
        const snapshot = manager.providerStatus[TYPE][0].state._kiroDiscoveredModels;
        manager.providerPools[TYPE][0] = { ...manager.providerPools[TYPE][0] };
        manager.initializeProviderStatus(true);
        const rotated = manager.refreshProviderUuid(TYPE, manager.providerStatus[TYPE][0].config);
        expect(manager.providerStatus[TYPE][0].state._kiroDiscoveredModels).toBe(snapshot);
        expect((await manager.selectProvider(TYPE, 'old-model', { excludeUuids: ['b'] })).uuid).toBe(rotated);
    });
    test('selection ignores a snapshot immediately after direct credential configuration edits', async () => {
        const manager = pool({ KIRO_DYNAMIC_MODELS: true });
        manager.updateKiroModelCapabilities(TYPE, 'a', ['old-model'], 60000);
        manager.providerStatus[TYPE][0].config.KIRO_OAUTH_CREDS_FILE_PATH = '/mock/replacement.json';
        manager.providerStatus[TYPE][1].config.isDisabled = true;
        expect((await manager.selectProvider(TYPE, model)).uuid).toBe('a');
    });
    test('global endpoint changes invalidate snapshots and late results cannot overwrite a new snapshot', () => {
        const manager = pool({ KIRO_DYNAMIC_MODELS: true, KIRO_MODELS_URL: 'https://old.invalid/models' });
        const a = manager.providerStatus[TYPE][0];
        const oldScope = kiroModelCapabilityScope({ ...manager.globalConfig, ...a.config });
        manager.updateKiroModelCapabilities(TYPE, 'a', ['old-model'], 60000, oldScope);
        manager.globalConfig = { ...manager.globalConfig, KIRO_MODELS_URL: 'https://new.invalid/models' };
        manager.initializeProviderStatus(true);
        expect(a.state._kiroDiscoveredModels).toBeUndefined();
        const newScope = kiroModelCapabilityScope({ ...manager.globalConfig, ...a.config });
        manager.updateKiroModelCapabilities(TYPE, 'a', ['new-model'], 60000, newScope);
        manager.updateKiroModelCapabilities(TYPE, 'a', ['old-model'], 60000, oldScope);
        expect([...a.state._kiroDiscoveredModels.ids]).toEqual(['new-model']);
    });
    test('API key discovery also invalidates capabilities when its region/profile credential source changes', () => {
        const manager = pool({ KIRO_DYNAMIC_MODELS: true, KIRO_API_KEY: 'ksk_same', KIRO_MODELS_URL: 'https://mock.invalid/models' });
        const a = manager.providerStatus[TYPE][0];
        const key = kiroBudgetKeyForConfig({ ...manager.globalConfig, ...a.config });
        manager.updateKiroModelCapabilities(TYPE, 'a', ['old-model'], 60000);
        manager.providerPools[TYPE][0] = { ...a.config, KIRO_OAUTH_CREDS_FILE_PATH: '/mock/new-region-profile.json' };
        manager.initializeProviderStatus(true);
        expect(kiroBudgetKeyForConfig({ ...manager.globalConfig, ...manager.providerPools[TYPE][0] })).toBe(key);
        expect(a.state._kiroDiscoveredModels).toBeUndefined();
    });
});

describe('bounded Kiro attempt logs', () => {
    test('a retry has one distinct trace per attempt and final native usage, with no raw secrets', async () => {
        logger.info.mockClear();
        const backend = service([], { KIRO_REQUEST_TRACE: true, REQUEST_MAX_RETRIES: 1 });
        backend.uuid = 'raw-account-id';
        backend.accessToken = 'private-bearer-secret';
        backend._requestWithBuilderEndpointRouting.mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
            .mockResolvedValueOnce({ data: Readable.from([text('private answer'), frame('metadataEvent', {
                stopReason: 'end_turn', tokenUsage: { uncachedInputTokens: 8, outputTokens: 2 } }),
                frame('meteringEvent', { unit: 'credit', usage: 0.1 })]) });
        await collect(backend.generateContentStream(model, request()));
        const logs = logger.info.mock.calls.flat().filter(value => typeof value === 'string' && value.startsWith('[Kiro Trace] '));
        const traces = logs.map(value => JSON.parse(value.slice('[Kiro Trace] '.length)));
        expect(traces.map(t => t.attempt)).toEqual([1, 2]);
        expect(traces[0]).toMatchObject({ outcome: 'error', errorKind: 'ECONNRESET' });
        expect(traces[1]).toMatchObject({ outcome: 'completed', usage: { input_tokens: 8, output_tokens: 2 }, credit_usage: 0.1 });
        expect(traces[0].requestId).toBe(traces[1].requestId);
        expect(logs.join()).not.toMatch(/raw-account-id|private-bearer-secret|private answer|hello/);
    });
});
