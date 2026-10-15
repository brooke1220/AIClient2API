/** Write one record without reading more upstream data while the client is slow. */
export function writeWithBackpressure(res, chunk, signal, onWritten = () => {}, options = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const cleanup = () => {
            clearTimeout(timer);
            res.off('drain', onDrain);
            res.off('close', onClose);
            res.off('error', onError);
            signal?.removeEventListener('abort', onAbort);
        };
        const finish = error => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error); else resolve();
        };
        const onDrain = () => finish();
        const onClose = () => finish(new Error('Client connection closed'));
        const onError = error => finish(error);
        const onAbort = () => finish(signal.reason || new Error('Client request aborted'));
        res.on('drain', onDrain);
        res.on('close', onClose);
        res.on('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            if (signal?.aborted) return onAbort();
            if (res.destroyed || res.writableEnded) return onClose();
            const writable = res.write(chunk);
            onWritten();
            if (writable !== false) finish();
            else if (!settled && Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0) {
                timer = setTimeout(() => {
                    const error = new Error(`Downstream write did not drain within ${options.timeoutMs}ms`);
                    error.code = 'DOWNSTREAM_WRITE_TIMEOUT';
                    error.isDownstreamWriteError = true;
                    finish(error);
                }, options.timeoutMs);
            }
        } catch (error) { finish(error); }
    });
}

/** Install before account selection, not after a request leaves its queue. */
export function clientRequestCancellation(req, res) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => { if (!res.writableEnded) abort(); };
    const onError = error => controller.abort(error);
    req.on?.('aborted', abort);
    res.on('close', onClose);
    res.on('error', onError);
    if (req.aborted || res.destroyed) abort();
    return { controller, cleanup() {
        req.off?.('aborted', abort);
        res.off('close', onClose);
        res.off('error', onError);
        controller.abort();
    } };
}
