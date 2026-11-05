import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import logger from '../../utils/logger.js';
import { readKiroTokenUsage, readKiroMetering } from './kiro-response-metadata.js';
import { hasKiroToolArguments } from './kiro-tool-assembler.js';

const MAX_TRACED_TOOL_CALLS = 64;

/** One bounded JSON log per attempt. No credentials, prompts, tool arguments, or images. */
export function createKiroRequestTrace(service, model, options, placeholderToolName) {
    if (service.config.KIRO_REQUEST_TRACE !== true) return null;
    const timing = options.kiroTiming ||= {};
    timing.traceId ||= randomUUID();
    timing.attempt = (timing.attempt || 0) + 1;
    const started = performance.now();
    // Classified times share the request origin so they line up with the
    // downstream summary; firstEventMs/durationMs stay attempt-relative.
    const origin = Number.isFinite(timing.startedAt) ? timing.startedAt : started;
    const sinceOrigin = () => Math.round(performance.now() - origin);
    const record = { requestId: timing.traceId, attempt: timing.attempt, startedAt: new Date().toISOString(),
        account: createHash('sha256').update(String(service.uuid || 'standalone')).digest('hex').slice(0, 16),
        model: String(model).slice(0, 128), attemptStartMs: Math.round(started - origin) };
    const placeholderIds = new Set();
    let placeholderOpen = false;
    let finished = false;
    return {
        headers() { record.headersMs ??= sinceOrigin(); },
        accept(event) {
            if (['content', 'reasoning', 'toolUse'].includes(event.type)) record.firstEventMs ??= Math.round(performance.now() - started);
            // Legacy inline <thinking> text is still content here; only the generator can split it.
            if (event.type === 'reasoning' && (event.data || event.redactedContent)) record.firstReasoningMs ??= sinceOrigin();
            if (event.type === 'content' && event.data) record.firstContentMs ??= sinceOrigin();
            // Stop once both tool times are known. Until then the placeholder set
            // tracks the IDs the generator itself already holds, never more.
            if (['toolUse', 'toolUseInput', 'toolUseStop'].includes(event.type)
                && (record.firstToolMs === undefined || record.firstToolArgsMs === undefined)) {
                const { name, toolUseId, input, stop } = event.data || {};
                if (name === placeholderToolName) {
                    if (toolUseId) placeholderIds.add(toolUseId);
                    // Mirror the generator's ignoredLegacyTool: stay open until a
                    // subsequent id-less stop clears it, even if this event itself
                    // carries stop.  Otherwise a later id-less fragment slips through.
                    else placeholderOpen = true;
                } else if (toolUseId ? !placeholderIds.has(toolUseId) : name || !placeholderOpen) {
                    if (name) {
                        placeholderOpen = false;
                        record.firstToolMs ??= sinceOrigin();
                    }
                    // A name-only start is not a parameter; count the first real fragment.
                    if (hasKiroToolArguments(input)) record.firstToolArgsMs ??= sinceOrigin();
                } else if (!toolUseId && stop) {
                    placeholderOpen = false;
                }
            }
            if (event.type === 'metadata') {
                const usage = readKiroTokenUsage(event.data.tokenUsage);
                if (usage) record.usage = { ...record.usage, ...usage };
                if (typeof event.data.stopReason === 'string') record.stopReason = event.data.stopReason.slice(0, 64);
            }
            if (event.type === 'metering') Object.assign(record, readKiroMetering({ usage: event.data.credit_usage,
                unit: event.data.credit_unit, unitPlural: event.data.credit_unit_plural }));
        },
        finish(error, complete = false) {
            if (finished) return;
            finished = true;
            record.durationMs = Math.round(performance.now() - started);
            record.transport = options._kiroTraceTransport || (options._transportContext?.kind === 'kiro-sidecar'
                ? options._transportContext.tlsSidecar ? 'kiro-sidecar+tls-sidecar' : 'kiro-sidecar' : 'direct');
            record.status = Number(error?.response?.status || error?.status || (error ? 502 : 200));
            record.outcome = options.signal?.aborted ? 'cancelled' : error ? 'error' : complete ? 'completed' : 'interrupted';
            record.errorKind = error?.kiroErrorKind || error?.code;
            record.usageSource = record.usage ? 'provider' : 'unreported';
            logger.info(`[Kiro Trace] ${JSON.stringify(record)}`);
        }
    };
}

/**
 * Per-call tool timing for one attempt, keyed by a local ordinal. Tool IDs and
 * arguments are never logged. All times share the request origin.
 */
export function logKiroToolTrace(timing, assembler) {
    if (!timing?.traceId || !assembler?.stats) return;
    const { stats, order } = assembler;
    if (!order.length && !stats.objectAfterString && !stats.emptyObjects) return;
    const firstNative = order.find(call => call.trace?.native);
    const calls = order.slice(0, MAX_TRACED_TOOL_CALLS).map(call => {
        const trace = call.trace || {};
        const waitMs = Number.isFinite(trace.firstWriteMs) && Number.isFinite(trace.firstArgsMs)
            ? trace.firstWriteMs - trace.firstArgsMs : undefined;
        // The batch-2 gate sample: first native call on a supported live stream
        // whose identity was ready, with no earlier open/emitted legacy tool
        // and no backpressure. Legacy-first responses keep validated output.
        const gateSample = timing.mode === 'stream' && timing.toolGate === true && call === firstNative
            && trace.identityReadyAtArgs === true && trace.priorOpenAtArgs === false
            && trace.priorLegacyEmitted !== true
            && trace.backpressure !== true && waitMs !== undefined;
        return { callKey: trace.callKey, native: trace.native, done: call.done === true, argumentBytes: call.argumentBytes,
            firstArgsMs: trace.firstArgsMs, identityMs: trace.identityMs, identityReadyAtArgs: trace.identityReadyAtArgs,
            priorOpenAtArgs: trace.priorOpenAtArgs, priorLegacyEmitted: trace.priorLegacyEmitted,
            validatedMs: trace.validatedMs, emittedMs: trace.emittedMs,
            firstWriteMs: trace.firstWriteMs, backpressure: trace.backpressure, waitMs, gateSample };
    });
    logger.info(`[Kiro Tool Trace] ${JSON.stringify({ requestId: timing.traceId, attempt: timing.attempt, mode: timing.mode,
        toolGate: timing.toolGate === true, snapshots: stats, callCount: order.length,
        truncated: Math.max(0, order.length - MAX_TRACED_TOOL_CALLS), calls })}`);
}
