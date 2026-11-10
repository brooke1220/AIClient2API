import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../../static/app/app.js', import.meta.url), 'utf8');
const loaderSource = await readFile(new URL('../../static/app/component-loader.js', import.meta.url), 'utf8');

// Execute the real startup and loader code with deterministic component responses.
// The other application modules are collaborators here; no browser or live API is needed.
function createHarness({ readyState = 'loading', staticPage = false, delayed = [] } = {}) {
    const pendingCallbacks = [];
    const createEvents = () => {
        const listeners = new Map();
        return {
            addEventListener(name, callback) {
                const callbacks = listeners.get(name) || [];
                callbacks.push(callback);
                listeners.set(name, callbacks);
            },
            dispatchEvent(event) {
                for (const callback of listeners.get(event.type) || []) {
                    const result = callback(event);
                    if (result?.then) pendingCallbacks.push(result);
                }
                return true;
            }
        };
    };
    const document = createEvents();
    document.readyState = readyState;
    const window = createEvents();
    const nodes = new Map();
    const insert = (container, html) => {
        container.children.push({ html });
        if (html.includes('section-usage.html')) nodes.set('refreshUsageBtn', {});
    };
    const container = () => ({
        children: [],
        insertAdjacentHTML(position, html) { insert(this, html); },
        set innerHTML(html) { this.children = []; insert(this, html); }
    });
    const outer = container();
    const sidebar = container();
    const content = container();
    nodes.set('sidebar-container', sidebar);
    nodes.set('content-container', content);
    document.getElementById = id => nodes.get(id) || null;
    document.querySelector = selector => selector === '.container'
        ? outer : document.getElementById(selector.slice(1));
    if (staticPage) {
        insert(sidebar, 'static sidebar');
        insert(content, 'static section-usage.html');
    }

    const delayedResponses = new Map();
    const requests = [];
    const calls = { usage: [], navigation: 0, intervals: 0 };
    const context = vm.createContext({
        window,
        document,
        console: { log() {}, warn() {}, error() {} },
        CustomEvent: class { constructor(type) { this.type = type; } },
        setInterval() { calls.intervals++; },
        fetch(path) {
            requests.push(path);
            const response = { ok: true, text: async () => path };
            if (delayed.includes(path)) {
                return new Promise(resolve => delayedResponses.set(path, () => resolve(response)));
            }
            return Promise.resolve(response);
        }
    });
    vm.runInContext(loaderSource.replace(/export\s*\{[\s\S]*?\};?/g, ''), context);

    return {
        context, document, window, sidebar, content, calls, requests,
        loadApp() {
            const source = appSource.replace(/import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"];?/g, (_, names) => {
                for (const name of names.split(',').map(value => value.trim()).filter(Boolean)) {
                    if (name !== 'getComponentLoadState') context[name] = function () {};
                }
                return '';
            });
            context.REFRESH_INTERVALS = { SYSTEM_INFO: 10000 };
            context.initUsageManager = () => calls.usage.push(Boolean(document.getElementById('refreshUsageBtn')));
            context.initNavigation = () => { calls.navigation++; };
            vm.runInContext(source, context);
        },
        release(path) {
            assert.ok(delayedResponses.has(path), `Expected pending component: ${path}`);
            delayedResponses.get(path)();
            delayedResponses.delete(path);
        },
        async drain() {
            // Header, sidebar, and sections each cross several promise boundaries.
            for (let index = 0; index < 30; index++) await Promise.resolve();
            await Promise.all(pendingCallbacks.splice(0));
        }
    };
}

test('partial dynamic components never initialize the app before the usage button exists', async () => {
    const harness = createHarness({ delayed: ['components/section-usage.html'] });
    harness.loadApp();
    const loading = harness.context.initializeComponents();
    assert.equal(harness.context.getComponentLoadState(), 'loading');
    await harness.drain();
    assert.ok(harness.sidebar.children.length > 0);
    assert.ok(harness.content.children.length > 0);

    harness.document.dispatchEvent({ type: 'DOMContentLoaded' });
    await harness.drain();
    assert.deepEqual(harness.calls.usage, []);
    assert.equal(harness.calls.navigation, 0);

    harness.release('components/section-usage.html');
    await loading;
    await harness.drain();
    assert.equal(harness.context.getComponentLoadState(), 'ready');
    assert.deepEqual(harness.calls.usage, [true]);
    assert.equal(harness.calls.navigation, 1);
});

test('normal dynamic completion initializes once across both readiness events', async () => {
    const harness = createHarness();
    harness.loadApp();
    harness.document.dispatchEvent({ type: 'DOMContentLoaded' });
    assert.deepEqual(harness.calls.usage, []);

    await harness.context.initializeComponents();
    harness.window.dispatchEvent({ type: 'componentsLoaded' });
    harness.document.dispatchEvent({ type: 'DOMContentLoaded' });
    await harness.drain();
    assert.deepEqual(harness.calls.usage, [true]);
    assert.equal(harness.calls.navigation, 1);
    assert.equal(harness.calls.intervals, 2);
});

test('an app imported after components and DOM readiness still initializes', async () => {
    const harness = createHarness({ readyState: 'complete' });
    await harness.context.initializeComponents();
    harness.loadApp();
    await harness.drain();
    assert.deepEqual(harness.calls.usage, [true]);
    assert.equal(harness.calls.navigation, 1);
});

test('an app imported during dynamic loading waits for the remaining components', async () => {
    const harness = createHarness({ readyState: 'interactive', delayed: ['components/section-usage.html'] });
    const loading = harness.context.initializeComponents();
    await harness.drain();
    harness.loadApp();
    assert.deepEqual(harness.calls.usage, []);
    harness.release('components/section-usage.html');
    await loading;
    await harness.drain();
    assert.deepEqual(harness.calls.usage, [true]);
});

test('complete static markup initializes without the dynamic loader', async () => {
    const harness = createHarness({ staticPage: true });
    harness.loadApp();
    assert.equal(harness.context.getComponentLoadState(), 'idle');
    harness.document.dispatchEvent({ type: 'DOMContentLoaded' });
    await harness.drain();
    assert.deepEqual(harness.calls.usage, [true]);
    assert.equal(harness.requests.length, 0);
});

test('a late app import also initializes complete static markup', async () => {
    const harness = createHarness({ readyState: 'complete', staticPage: true });
    harness.loadApp();
    await harness.drain();
    assert.deepEqual(harness.calls.usage, [true]);
});

test('a sidebar alone is insufficient for the static fallback', async () => {
    const harness = createHarness();
    harness.sidebar.children.push({ html: 'sidebar' });
    harness.loadApp();
    harness.document.dispatchEvent({ type: 'DOMContentLoaded' });
    await harness.drain();
    assert.deepEqual(harness.calls.usage, []);
});

test('failed dynamic loading does not mark a partial page ready', async () => {
    const harness = createHarness();
    harness.context.fetch = async () => ({ ok: false, status: 503 });
    harness.loadApp();
    await assert.rejects(harness.context.initializeComponents(), /503/);
    assert.equal(harness.context.getComponentLoadState(), 'error');
    harness.sidebar.children.push({});
    harness.content.children.push({});
    harness.document.dispatchEvent({ type: 'DOMContentLoaded' });
    harness.window.dispatchEvent({ type: 'componentsLoaded' });
    await harness.drain();
    assert.deepEqual(harness.calls.usage, []);
});
