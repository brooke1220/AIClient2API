import { parentPort } from 'node:worker_threads';
import { countTextTokens, warmupTokenizer } from './token-utils.js';

warmupTokenizer();
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', ({ id, texts }) => {
    try {
        // Count each complete text independently. BPE counts of arbitrary
        // streaming fragments cannot be added without changing the result.
        parentPort.postMessage({ id, count: texts.reduce((sum, text) => sum + countTextTokens(text), 0) });
    } catch {
        parentPort.postMessage({ id, error: true });
    }
});
