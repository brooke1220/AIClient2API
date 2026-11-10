import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const test = (name, run) => nodeTest(name, { timeout: 2000 }, run);

// These tests exercise the shipped page logic with controlled completion order.
// They do not call a real provider or require a running management server.
const source = (await readFile(new URL('../../static/app/usage-manager.js', import.meta.url), 'utf8'))
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^export /gm, '');

function deferred() {
    let resolve, reject;
    const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
    return { promise, resolve, reject };
}

class Element {
    constructor(className = '') {
        this.attributes = new Map();
        this.dataset = {};
        this.style = { display: 'none' };
        this.children = [];
        this.listeners = new Map();
        this.disabled = false;
        this.textContent = '';
        this.htmlWrites = 0;
        this.classes = new Set(className.split(/\s+/).filter(Boolean));
        this.classList = {
            contains: value => this.classes.has(value),
            add: (...values) => values.forEach(value => this.classes.add(value)),
            remove: (...values) => values.forEach(value => this.classes.delete(value)),
            toggle: (value, force) => {
                const include = force ?? !this.classes.has(value);
                if (include) this.classes.add(value); else this.classes.delete(value);
                return include;
            }
        };
    }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(' '); }
    set innerHTML(value) { this.html = value; this.htmlWrites++; this.children = []; }
    get innerHTML() { return this.html || ''; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, callback) {
        const callbacks = this.listeners.get(name) || [];
        callbacks.push(callback);
        this.listeners.set(name, callbacks);
    }
    appendChild(child) { this.children.push(child); child.parent = this; return child; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    querySelector(selector) {
        if (selector === 'i' || selector.includes('fa-sync')) return this.icon || null;
        if (selector === 'span' || selector.includes('data-i18n')) return this.label || null;
        const provider = selector.match(/data-provider="([^"]+)"/);
        if (provider) return this.children.find(child => child.getAttribute('data-provider') === provider[1]) || null;
        return null;
    }
    querySelectorAll() { return []; }
}

function harness({ button = true, respond } = {}) {
    const elements = new Map([
        ['usageLoading', new Element()], ['usageError', new Element()],
        ['usageErrorMessage', new Element()], ['usageContent', new Element()],
        ['usageLastUpdate', new Element()], ['serverTimeValue', new Element()]
    ]);
    const toasts = [], requests = [], timers = new Map();
    let timerId = 0;
    const addButton = () => {
        const value = new Element();
        value.icon = new Element('fas fa-sync-alt');
        value.label = new Element();
        value.label.textContent = 'usage.refresh';
        elements.set('refreshUsageBtn', value);
        return value;
    };
    if (button) addButton();
    const context = vm.createContext({
        console: { error() {} }, Date, AbortController,
        document: {
            getElementById: id => elements.get(id) || null,
            createElement: () => new Element()
        },
        window: { confirm: () => true },
        getAuthHeaders: () => ({ Authorization: 'Bearer fixture-only' }),
        getCurrentLanguage: () => 'en-US',
        getBaseProviderConfigs: () => [],
        t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
        showToast: (...args) => toasts.push(args),
        bindOnce: (element, name, callback, key = name) => {
            if (!element || element.dataset[key]) return false;
            element.dataset[key] = 'true';
            element.addEventListener(name, callback);
            return true;
        },
        setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
        clearTimeout: id => timers.delete(id),
        fetch: (url, options = {}) => {
            const response = deferred();
            let bodyReject;
            const request = {
                url, options,
                respond: (payload, status = 200) => response.resolve({
                    ok: status >= 200 && status < 300, status,
                    json: async () => payload
                }),
                respondWithPendingBody: () => response.resolve({
                    ok: true, status: 200,
                    json: () => new Promise((resolve, reject) => { bodyReject = reject; })
                }),
                reject: response.reject
            };
            options.signal?.addEventListener('abort', () => {
                const error = new Error('Aborted'); error.name = 'AbortError';
                response.reject(error); bodyReject?.(error);
            }, { once: true });
            requests.push(request);
            respond?.(request);
            return response.promise;
        }
    });
    vm.runInContext(source, context, { filename: 'static/app/usage-manager.js' });
    return {
        page: context, elements, requests, toasts, timers, addButton,
        fireTimeout(ms = 120000) {
            const entry = [...timers].find(([, timer]) => timer.ms === ms);
            assert.ok(entry, `Expected a pending ${ms} ms request timeout`);
            timers.delete(entry[0]); entry[1].callback();
        }
    };
}

const emptyUsage = (timestamp = '2026-11-10T01:00:00.000Z') => ({ providers: {}, timestamp, serverTime: timestamp });
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const errorToasts = fixture => fixture.toasts.filter(args => args.at(-1) === 'error');

function assertIdle(fixture) {
    const button = fixture.elements.get('refreshUsageBtn');
    assert.equal(button.disabled, false, 'refresh button must allow another attempt');
    assert.notEqual(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.icon.classList.contains('fa-spin'), false);
    assert.equal(fixture.elements.get('usageLoading').style.display, 'none');
}

test('usage page entry binds a button that arrived after initial setup, once', async () => {
    const fixture = harness({ button: false, respond: request => request.respond(emptyUsage()) });
    fixture.page.initUsageManager();
    const button = fixture.addButton();
    await fixture.page.loadUsagePageData();
    await fixture.page.loadUsagePageData();
    assert.equal(button.listeners.get('click')?.length, 1, 'late component must receive one refresh handler');
});

test('full refresh displays persistent progress and coalesces repeated clicks', async () => {
    const fixture = harness();
    const first = fixture.page.refreshUsage();
    const second = fixture.page.refreshUsage();
    const button = fixture.elements.get('refreshUsageBtn');
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].url, '/api/usage?refresh=true');
    assert.equal(fixture.requests[0].options.cache, 'no-store');
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.icon.classList.contains('fa-spin'), true);
    assert.notEqual(fixture.elements.get('usageLoading').style.display, 'none');
    fixture.requests[0].respond(emptyUsage());
    await Promise.all([first, second]);
    assertIdle(fixture);
    assert.equal(fixture.timers.size, 0, 'completed requests must release timeout timers');
});

test('a hung refresh aborts at its deadline and leaves the button retryable', async () => {
    const fixture = harness();
    const pending = fixture.page.refreshUsage();
    fixture.fireTimeout();
    await pending;
    assert.equal(fixture.requests[0].options.signal.aborted, true);
    assert.ok(errorToasts(fixture).some(args => args.some(value => String(value).includes('usage.requestTimeout'))));
    assertIdle(fixture);
    const retry = fixture.page.refreshUsage();
    assert.equal(fixture.requests.length, 2);
    fixture.requests[1].respond(emptyUsage());
    await retry;
    assertIdle(fixture);
});

test('the deadline also covers an unfinished JSON response body', async () => {
    const fixture = harness();
    const pending = fixture.page.refreshUsage();
    fixture.requests[0].respondWithPendingBody();
    await settle();
    fixture.fireTimeout();
    await pending;
    assert.ok(errorToasts(fixture).length > 0, 'body timeout must be reported');
    assertIdle(fixture);
});

test('an HTTP failure restores the button and preserves the error for a retry', async () => {
    const fixture = harness();
    const failed = fixture.page.refreshUsage();
    fixture.requests[0].respond({ error: { message: 'fixture upstream unavailable' } }, 503);
    await failed;
    assert.ok(errorToasts(fixture).some(args => args.includes('fixture upstream unavailable')));
    assertIdle(fixture);
    const retry = fixture.page.refreshUsage();
    fixture.requests[1].respond(emptyUsage());
    await retry;
    assertIdle(fixture);
});

test('a late cached response cannot overwrite a manual refresh', async () => {
    const fixture = harness();
    const cached = fixture.page.loadUsage();
    const fresh = fixture.page.refreshUsage();
    assert.equal(fixture.requests.length, 2);
    fixture.requests[1].respond(emptyUsage('2026-11-10T02:00:00.000Z'));
    await fresh;
    const updatedTime = fixture.elements.get('usageLastUpdate').textContent;
    const updatedServerTime = fixture.elements.get('serverTimeValue').textContent;
    const contentWrites = fixture.elements.get('usageContent').htmlWrites;
    fixture.requests[0].respond({ ...emptyUsage('2026-11-10T01:00:00.000Z'), fromCache: true });
    await cached;
    assert.equal(fixture.elements.get('usageLastUpdate').textContent, updatedTime);
    assert.equal(fixture.elements.get('serverTimeValue').textContent, updatedServerTime);
    assert.equal(fixture.elements.get('usageContent').htmlWrites, contentWrites);
    assertIdle(fixture);
});

test('a stale load failure cannot replace a successful refresh with an error', async () => {
    const fixture = harness();
    const cached = fixture.page.loadUsage();
    const fresh = fixture.page.refreshUsage();
    fixture.requests[1].respond(emptyUsage());
    await fresh;
    fixture.requests[0].reject(new Error('obsolete load failed'));
    await cached;
    assert.equal(fixture.elements.get('usageError').style.display, 'none');
    assertIdle(fixture);
});

test('entering the page during a refresh waits for fresh data without another cached GET', async () => {
    const fixture = harness();
    const refresh = fixture.page.refreshUsage();
    const load = fixture.page.loadUsage();
    assert.equal(fixture.requests.length, 1);
    fixture.requests[0].respond(emptyUsage());
    await Promise.all([refresh, load]);
    assertIdle(fixture);
});

test('provider refresh consumes the direct provider response without reloading stale cache', async () => {
    const fixture = harness();
    const group = new Element();
    group.setAttribute('data-provider', 'claude-kiro-oauth');
    fixture.elements.get('usageContent').appendChild(group);
    const pending = fixture.page.refreshProviderUsage('claude-kiro-oauth');
    fixture.requests[0].respond({
        providerType: 'claude-kiro-oauth', instances: [], totalCount: 0,
        successCount: 0, errorCount: 0, serverTime: '2026-11-10T02:00:00.000Z'
    });
    await pending;
    assert.equal(fixture.requests.length, 1, 'direct provider payload must not trigger a cache GET');
    assert.equal(fixture.elements.get('usageContent').children.includes(group), false, 'provider response must update its group');
    assert.ok(fixture.elements.get('serverTimeValue').textContent);
});

test('a provider refresh supersedes a pending cached load, including stale failures', async () => {
    for (const staleResult of ['data', 'error']) {
        const fixture = harness();
        const group = new Element();
        group.setAttribute('data-provider', 'claude-kiro-oauth');
        fixture.elements.get('usageContent').appendChild(group);
        const cached = fixture.page.loadUsage();
        const provider = fixture.page.refreshProviderUsage('claude-kiro-oauth');
        fixture.requests[1].respond({
            providerType: 'claude-kiro-oauth', instances: [], totalCount: 0,
            successCount: 0, errorCount: 0, serverTime: '2026-11-10T02:00:00.000Z'
        });
        await provider;
        const updatedTime = fixture.elements.get('usageLastUpdate').textContent;
        const updatedServerTime = fixture.elements.get('serverTimeValue').textContent;
        const contentWrites = fixture.elements.get('usageContent').htmlWrites;
        assert.equal(fixture.requests.length, 2, 'provider refresh must not launch another cached load');
        assert.equal(fixture.elements.get('usageContent').children.includes(group), false);
        assertIdle(fixture);
        if (staleResult === 'data') {
            fixture.requests[0].respond({ ...emptyUsage('2026-11-10T01:00:00.000Z'), fromCache: true });
        } else {
            fixture.requests[0].reject(new Error('obsolete cache request failed'));
        }
        await cached;
        assert.equal(fixture.elements.get('usageLastUpdate').textContent, updatedTime, staleResult);
        assert.equal(fixture.elements.get('serverTimeValue').textContent, updatedServerTime, staleResult);
        assert.equal(fixture.elements.get('usageContent').htmlWrites, contentWrites, staleResult);
        assert.equal(fixture.elements.get('usageError').style.display, 'none', staleResult);
        assertIdle(fixture);
    }
});
