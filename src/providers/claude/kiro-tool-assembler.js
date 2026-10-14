import { v4 as uuidv4 } from 'uuid';
import { kiroIntegrityError } from './kiro-event-stream.js';

/** Buffer individual tools until validated, then emit in arrival order. */
export class KiroToolAssembler {
    constructor(maxBytes = 4 * 1024 * 1024, maxCalls = 1024) {
        this.calls = new Map();
        this.order = [];
        this.emitted = 0;
        this.lastId = null;
        this.maxBytes = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : 4 * 1024 * 1024;
        this.maxCalls = Number.isFinite(Number(maxCalls)) && Number(maxCalls) > 0 ? Number(maxCalls) : 1024;
        this.bytes = 0;
    }

    feed(event, { legacy = false } = {}) {
        let id = event.toolUseId;
        if (!id && event.name) id = `tool_${uuidv4()}`;
        if (!id) {
            const open = this.order.filter(call => !call.done);
            if (open.length !== 1) throw kiroIntegrityError('ambiguous tool fragment without ID');
            id = open[0].id;
        }
        let call = this.calls.get(id);
        const previous = legacy ? null : this.calls.get(this.lastId);
        if (!call && event.toolUseId && previous?.synthetic && !previous.done && (!event.name || previous.name === event.name)) {
            this.calls.delete(previous.id);
            previous.id = id;
            previous.synthetic = false;
            this.calls.set(id, previous);
            call = previous;
        }
        if (call?.done && event.stop && !event.input && (!event.name || event.name === call.name)) return [];
        if (!call && event.name) {
            // A legacy opening fragment may receive its real ID later.
            const previous = legacy ? null : this.calls.get(this.lastId);
            if (previous?.synthetic && !previous.done && previous.name === event.name) {
                this.calls.delete(previous.id);
                previous.id = id;
                previous.synthetic = false;
                call = previous;
            } else {
                if (this.order.length >= this.maxCalls) throw kiroIntegrityError('tool call count limit exceeded');
                call = { id, name: event.name, arguments: '', argumentBytes: 0, trailingHighSurrogate: false,
                    done: false, synthetic: !event.toolUseId, legacy };
                this.order.push(call);
            }
            this.calls.set(id, call);
        }
        if (!call || call.done) throw kiroIntegrityError('orphan or completed tool fragment');
        if (event.name && event.name !== call.name) throw kiroIntegrityError('tool name changed within a call');
        if (!legacy) this.lastId = id;
        if (event.input !== undefined && event.input !== null) {
            const previousBytes = call.argumentBytes;
            if (typeof event.input === 'object') {
                if (Object.keys(event.input).length) {
                    call.arguments = JSON.stringify(event.input);
                    call.argumentBytes = Buffer.byteLength(call.arguments);
                    call.trailingHighSurrogate = false;
                }
            } else {
                const fragment = String(event.input);
                if (fragment) {
                    const first = fragment.charCodeAt(0);
                    // Two lone UTF-16 surrogates cost 6 UTF-8 bytes separately,
                    // but form one 4-byte character when joined across deltas.
                    const joinsSurrogatePair = call.trailingHighSurrogate && first >= 0xdc00 && first <= 0xdfff;
                    call.argumentBytes += Buffer.byteLength(fragment) - (joinsSurrogatePair ? 2 : 0);
                    const last = fragment.charCodeAt(fragment.length - 1);
                    call.trailingHighSurrogate = last >= 0xd800 && last <= 0xdbff;
                    call.arguments += fragment;
                }
            }
            this.bytes += call.argumentBytes - previousBytes;
            if (this.bytes > this.maxBytes) throw kiroIntegrityError('tool argument buffer limit exceeded');
        }
        if (event.stop) this.complete(call);
        return this.drain();
    }

    complete(call) {
        let input;
        try { input = JSON.parse(call.arguments || '{}'); }
        catch { throw kiroIntegrityError('incomplete tool argument JSON'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw kiroIntegrityError('tool input must be a JSON object');
        call.input = input;
        if (!call.arguments) {
            call.arguments = '{}';
            call.argumentBytes = 2;
            this.bytes += 2;
            if (this.bytes > this.maxBytes) throw kiroIntegrityError('tool argument buffer limit exceeded');
        }
        call.done = true;
    }

    drain() {
        const completed = [];
        while (this.emitted < this.order.length && this.order[this.emitted].done) {
            const call = this.order[this.emitted++];
            completed.push({ toolUseId: call.id, name: call.name, input: call.input, arguments: call.arguments,
                ...(call.legacy ? { legacy: true } : {}) });
        }
        return completed;
    }

    finish() {
        for (const call of this.order) {
            if (!call.done) {
                if (!call.arguments) throw kiroIntegrityError('unfinished empty tool call');
                this.complete(call);
            }
        }
        return this.drain();
    }
}
