import { kiroIntegrityError } from './kiro-event-stream.js';

export function resolveKiroToolStreamMode(config, options = {}) {
    if (options.kiroOutputMode === 'unary' || options.kiroOutputMode === 'buffered'
        || options.kiroToolStreamMode === 'validated') return 'validated';
    return config?.KIRO_TOOL_STREAM_MODE === 'incremental' && options.kiroTiming?.toolGate === true
        ? 'incremental' : 'validated';
}

const positiveLimit = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

/**
 * Read interleaved upstream calls without blocking the frames needed to finish
 * the active call. Tool arguments remain owned by the assembler; only content
 * and small call references are queued here. The queue never owns argument copies.
 */
export class KiroToolStream {
    constructor(assembler, { maxQueueBytes, maxQueueEvents, placeholderName, shouldStream = () => true } = {}) {
        this.assembler = assembler;
        this.maxQueueBytes = positiveLimit(maxQueueBytes, 4 * 1024 * 1024);
        this.maxQueueEvents = positiveLimit(maxQueueEvents, 4096);
        this.placeholderName = placeholderName;
        this.shouldStream = shouldStream;
        this.queue = [];
        this.queuedBytes = 0;
        this.known = new Set();
        this.entries = new Map();
        this.ignoredIds = new Set();
        this.ignoredWithoutId = false;
    }

    enqueue(entry, bytes) {
        if (this.queue.length >= this.maxQueueEvents || this.queuedBytes + bytes > this.maxQueueBytes) {
            throw kiroIntegrityError('tool stream pending queue limit exceeded');
        }
        entry.bytes = bytes;
        this.queue.push(entry);
        this.queuedBytes += bytes;
    }

    shift() {
        const entry = this.queue.shift();
        this.queuedBytes -= entry.bytes;
        if (entry.call) this.entries.delete(entry.call.callKey);
    }

    *drain() {
        while (this.queue.length) {
            const entry = this.queue[0];
            if (entry.event) {
                this.shift();
                yield entry.event;
                continue;
            }
            const call = entry.call;
            if (!entry.contentFlushed) {
                entry.contentFlushed = true;
                // The consumer may discover a text-form tool in its pending
                // lookahead. Flush it before deciding native deduplication.
                yield { type: 'toolStreamBoundary' };
            }
            if (!call.incrementalStarted) {
                // Legacy-first output needs full signatures before deduplication;
                // a missing real ID can only be emitted once the call is final.
                const eligible = !call.synthetic && this.shouldStream();
                if (!eligible) {
                    if (!call.done) break;
                    this.shift();
                    yield { type: 'toolStreamComplete', call, incremental: false };
                    continue;
                }
                if (!call.done && !call.hasMeaningfulArguments) break;
                call.incrementalStarted = true;
                call.outputCharacters = 0;
                yield { type: 'toolStreamStart', call };
            }
            if (call.arguments.length > call.outputCharacters) {
                const fragment = call.arguments.slice(call.outputCharacters);
                // Set before yielding: a future object snapshot must preserve
                // every prefix handed to the writer, including a pending write.
                call.outputCharacters = call.arguments.length;
                yield { type: 'toolStreamDelta', call, fragment };
            }
            if (!call.done) break;
            this.shift();
            yield { type: 'toolStreamComplete', call, incremental: true };
        }
    }

    async *transform(source) {
        try {
            for await (const event of source) {
                if (['toolUse', 'toolUseInput', 'toolUseStop'].includes(event.type)) {
                    const tool = event.type === 'toolUse' ? event.toolUse
                        : { toolUseId: event.toolUseId, input: event.input, stop: event.stop };
                    if (tool.name === this.placeholderName || this.ignoredIds.has(tool.toolUseId)) {
                        if (tool.toolUseId) this.ignoredIds.add(tool.toolUseId);
                        else this.ignoredWithoutId = true;
                        continue;
                    }
                    if (!tool.name && !tool.toolUseId && this.ignoredWithoutId) {
                        if (tool.stop) this.ignoredWithoutId = false;
                        continue;
                    }
                    if (tool.name) this.ignoredWithoutId = false;
                    const { call } = this.assembler.feedUpdates(tool);
                    if (call && !this.known.has(call.callKey)) {
                        this.known.add(call.callKey);
                        const entry = { call };
                        this.enqueue(entry, Buffer.byteLength(call.name) + Buffer.byteLength(call.id) + 128);
                        this.entries.set(call.callKey, entry);
                    } else if (call && this.entries.has(call.callKey)) {
                        const entry = this.entries.get(call.callKey);
                        const bytes = Buffer.byteLength(call.name) + Buffer.byteLength(call.id) + 128;
                        if (this.queuedBytes + bytes - entry.bytes > this.maxQueueBytes) {
                            throw kiroIntegrityError('tool stream pending queue limit exceeded');
                        }
                        this.queuedBytes += bytes - entry.bytes;
                        entry.bytes = bytes;
                    }
                } else if (this.queue.length && (event.type === 'content' || event.type === 'reasoning')) {
                    this.enqueue({ event }, Buffer.byteLength(JSON.stringify(event)));
                } else yield event;
                yield* this.drain();
            }
            this.assembler.finishUpdates();
            yield* this.drain();
            if (this.queue.length) throw kiroIntegrityError('unfinished tool stream queue');
        } finally {
            this.queue.length = 0;
            this.queuedBytes = 0;
            this.known.clear();
            this.entries.clear();
            this.ignoredIds.clear();
        }
    }
}
