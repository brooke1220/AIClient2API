import { getEventListeners } from 'node:events';
import { acquireProviderSlot } from '../src/providers/provider-slot-lease.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const provider = () => ({ config: { uuid: 'old', concurrencyLimit: 1, queueLimit: 5 }, state: { activeCount: 0, waitingCount: 0, queue: [] } });

describe('atomic, cancellable account-slot leases', () => {
    test('slot transfer cannot let a new request oversubscribe the limit', async () => {
        const node = provider(); const first = await acquireProviderSlot(node);
        const queued = acquireProviderSlot(node); await tick(); first._slotLease.release();
        const arriving = acquireProviderSlot(node); const second = await queued;
        expect(node.state.activeCount).toBe(1); expect(node.state.waitingCount).toBe(1);
        second._slotLease.release(); const third = await arriving;
        expect(node.state.activeCount).toBe(1); third._slotLease.release();
        expect(node.state.activeCount).toBe(0);
    });
    test('lease release is idempotent and independent of a rotated UUID', async () => {
        const node = provider(); const acquired = await acquireProviderSlot(node); node.config.uuid = 'new';
        acquired._slotLease.release(); acquired._slotLease.release();
        expect(node.state.activeCount).toBe(0);
        expect(JSON.stringify(acquired)).not.toContain('slotLease');
    });
    test('aborting a queued caller removes its reservation immediately', async () => {
        const node = provider(); const first = await acquireProviderSlot(node); const controller = new AbortController();
        const waiting = acquireProviderSlot(node, { signal: controller.signal });
        const rejection = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
        controller.abort(); await rejection;
        expect(node.state.waitingCount).toBe(0); expect(node.state.queue).toHaveLength(0);
        expect(node.state.activeCount).toBe(1); expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        first._slotLease.release();
    });
    test('abort racing with a grant releases the reserved slot before rejecting', async () => {
        const node = provider(); const first = await acquireProviderSlot(node); const controller = new AbortController();
        const waiting = acquireProviderSlot(node, { signal: controller.signal }); await tick();
        first._slotLease.release(); controller.abort(); await expect(waiting).rejects.toBe(controller.signal.reason);
        expect(node.state.activeCount).toBe(0); expect(node.state.waitingCount).toBe(0);
    });
    test('queue deadlines clean up both the queue and abort subscription', async () => {
        const node = provider(); const first = await acquireProviderSlot(node); const controller = new AbortController();
        await expect(acquireProviderSlot(node, { signal: controller.signal, queueTimeout: 10 })).rejects.toThrow(/Queue timeout/);
        expect(node.state.waitingCount).toBe(0); expect(node.state.queue).toHaveLength(0);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0); first._slotLease.release();
    });
    test('pre-aborted callers never consume a slot', async () => {
        const node = provider(); const controller = new AbortController(); controller.abort();
        await expect(acquireProviderSlot(node, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
        expect(node.state.activeCount).toBe(0);
    });
    test('hot-reloaded lower limits also govern releases made by older leases', async () => {
        const node = provider(); node.config.concurrencyLimit = 2;
        const first = await acquireProviderSlot(node), second = await acquireProviderSlot(node);
        const queued = acquireProviderSlot(node); await tick();
        Object.defineProperty(node.state, '_slotConfig', { value: { ...node.config, concurrencyLimit: 1 } });
        first._slotLease.release(); expect(node.state.activeCount).toBe(1); expect(node.state.waitingCount).toBe(1);
        second._slotLease.release(); const third = await queued;
        expect(node.state.activeCount).toBe(1); third._slotLease.release();
    });

    test('a full queue returns the existing 429 contract', async () => {
        const node = provider(); node.config.queueLimit = 0; const first = await acquireProviderSlot(node);
        await expect(acquireProviderSlot(node)).rejects.toMatchObject({ status: 429 }); first._slotLease.release();
    });
});
