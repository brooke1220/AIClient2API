import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import logger from '../../utils/logger.js';
import { readKiroTokenUsage, readKiroMetering } from './kiro-response-metadata.js';

/** One bounded JSON log per attempt. No credentials, prompts, tool arguments, or images. */
export function createKiroRequestTrace(service, model, options) {
    if (service.config.KIRO_REQUEST_TRACE !== true) return null;
    const timing = options.kiroTiming ||= {};
    timing.traceId ||= randomUUID();
    timing.attempt = (timing.attempt || 0) + 1;
    const started = performance.now();
    const record = { requestId: timing.traceId, attempt: timing.attempt, startedAt: new Date().toISOString(),
        account: createHash('sha256').update(String(service.uuid || 'standalone')).digest('hex').slice(0, 16),
        model: String(model).slice(0, 128) };
    let finished = false;
    return {
        accept(event) {
            if (['content', 'reasoning', 'toolUse'].includes(event.type)) record.firstEventMs ??= Math.round(performance.now() - started);
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
