function limitFor(provider) {
    return Math.max(0, Number.parseInt((provider.state._slotConfig || provider.config).concurrencyLimit || 0, 10) || 0);
}

function reserve(provider) {
    const state = provider.state;
    state.activeCount++;
    let released = false;
    const lease = {
        get released() { return released; },
        release() {
            if (released) return;
            released = true;
            releaseProviderSlot(provider);
        }
    };
    const config = { ...(state._slotConfig || provider.config) };
    Object.defineProperty(config, '_slotLease', { value: lease });
    return config;
}

/** Transfer a freed slot atomically before waking a waiting request. */
export function releaseProviderSlot(provider) {
    const state = provider.state;
    if (state.activeCount > 0) state.activeCount--;
    const limit = limitFor(provider);
    while (state.queue.length && (limit <= 0 || state.activeCount < limit)) {
        const waiter = state.queue.shift();
        waiter.grant();
    }
}

export async function acquireProviderSlot(provider, options = {}) {
    const { signal } = options;
    signal?.throwIfAborted();
    const state = provider.state;
    const limit = limitFor(provider);
    if (limit <= 0 || state.activeCount < limit && !state.queue.length) return reserve(provider);
    const queueLimit = Math.max(0, Number.parseInt((state._slotConfig || provider.config).queueLimit || 0, 10) || 0);
    if (queueLimit <= 0 || state.waitingCount >= queueLimit) {
        const error = new Error('Too many requests: account concurrency limit and queue reached');
        error.status = 429;
        error.code = 429;
        throw error;
    }
    state.waitingCount++;
    const config = await new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const cleanup = () => {
            settled = true;
            state.waitingCount--;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        const fail = reason => {
            if (settled) return;
            const index = state.queue.indexOf(waiter);
            if (index !== -1) state.queue.splice(index, 1);
            cleanup();
            reject(reason);
        };
        const onAbort = () => fail(signal.reason);
        const waiter = {
            grant() {
                if (settled) return;
                if (signal?.aborted) return fail(signal.reason);
                const reserved = reserve(provider); // Reserve before resolve(), not after await.
                cleanup();
                resolve(reserved);
            }
        };
        state.queue.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
        const timeout = Number.isFinite(options.queueTimeout) && options.queueTimeout > 0 ? options.queueTimeout : 300000;
        timer = setTimeout(() => fail(new Error(`Queue timeout after ${timeout / 1000}s`)), timeout);
        if (signal?.aborted) onAbort();
    });
    if (signal?.aborted) {
        config._slotLease.release();
        signal.throwIfAborted();
    }
    return config;
}
