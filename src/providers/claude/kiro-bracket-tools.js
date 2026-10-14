import { kiroIntegrityError } from './kiro-event-stream.js';

const MARKER = '[Called';
const HEADER = /^\[Called\s+([a-zA-Z0-9_.:-]+)\s+with\s+args:\s*$/i;
const CALL = /^\[Called\s+([a-zA-Z0-9_.:-]+)\s+with\s+args:\s*([\s\S]*)\]$/i;
const HEADER_LIMIT = 1024;
const QUOTES = { '"': '"', "'": "'", '“': '”', '‘': '’' };

/** Incremental legacy tool decoding; ordinary text is never buffered to EOF. */
export class KiroBracketToolParser {
    constructor(allowName, maxArgumentBytes = 4 * 1024 * 1024) {
        this.allowName = allowName;
        this.remainingBytes = typeof maxArgumentBytes === 'function' ? maxArgumentBytes : () => maxArgumentBytes;
        this.pending = '';
        this.candidate = null;
        this.previousChar = '';
        this.codeDelimiter = null;
        this.delimiterChar = null;
        this.delimiterRun = 0;
        this.literalQuote = null;
        this.literalEscape = false;
    }

    flushDelimiter() {
        if (!this.delimiterRun) return;
        if (!this.codeDelimiter) {
            if (this.delimiterChar === '`' || this.delimiterRun >= 3) {
                this.codeDelimiter = { character: this.delimiterChar, length: this.delimiterRun };
            }
        } else if (this.delimiterChar === this.codeDelimiter.character &&
            (this.delimiterRun === this.codeDelimiter.length || this.codeDelimiter.length >= 3 && this.delimiterRun >= this.codeDelimiter.length)) {
            this.codeDelimiter = null;
        }
        this.delimiterChar = null;
        this.delimiterRun = 0;
    }

    noteLiteral(text) {
        for (const character of text) {
            if ((character === '`' || character === '~') && !this.literalQuote && this.previousChar !== '\\') {
                if (this.delimiterChar && this.delimiterChar !== character) this.flushDelimiter();
                this.delimiterChar = character;
                this.delimiterRun++;
            }
            else {
                this.flushDelimiter();
                if (!this.codeDelimiter) {
                    if (this.literalEscape) this.literalEscape = false;
                    else if (this.literalQuote && character === '\\') this.literalEscape = true;
                    else if (character === this.literalQuote) this.literalQuote = null;
                    else if (!this.literalQuote && Object.hasOwn(QUOTES, character) &&
                        (character !== "'" || !/[a-zA-Z0-9]/.test(this.previousChar))) this.literalQuote = QUOTES[character];
                }
            }
            this.previousChar = character;
        }
    }

    emitText(events, value) {
        if (!value) return;
        this.noteLiteral(value);
        if (typeof events === 'function') { events({ type: 'text', text: value }); return; }
        const previous = events.at(-1);
        if (previous?.type === 'text') previous.text += value;
        else events.push({ type: 'text', text: value });
    }

    appendCandidate(segment) {
        if (!segment) return;
        const candidate = this.candidate;
        const first = segment.charCodeAt(0);
        const joinedPair = candidate.trailingHigh && first >= 0xdc00 && first <= 0xdfff;
        candidate.bytes += Buffer.byteLength(segment) - (joinedPair ? 2 : 0);
        const last = segment.charCodeAt(segment.length - 1);
        candidate.trailingHigh = last >= 0xd800 && last <= 0xdbff;
        this.checkBudget();
        candidate.parts.push(segment);
    }

    checkBudget() {
        const candidate = this.candidate;
        if (candidate?.name && candidate.bytes > this.remainingBytes() + candidate.headerBytes + 1) {
            throw kiroIntegrityError('legacy tool argument buffer limit exceeded');
        }
    }

    consumeCandidate(data, events) {
        const candidate = this.candidate;
        let end = data.length;
        let completed = false;
        let literal = false;
        for (let index = 0; index < data.length; index++) {
            const character = data[index];
            if (!candidate.name) {
                candidate.header += character;
                const header = character === ':' ? candidate.header.match(HEADER) : null;
                if (header) {
                    if (this.allowName(header[1])) {
                        candidate.name = header[1];
                        candidate.headerBytes = Buffer.byteLength(candidate.header);
                    }
                    else literal = true;
                } else if (candidate.header.length > HEADER_LIMIT) literal = true;
            }
            if (literal) { end = index + 1; break; }
            if (candidate.escaped) candidate.escaped = false;
            else if (candidate.quoted && character === '\\') candidate.escaped = true;
            else if (character === '"') candidate.quoted = !candidate.quoted;
            else if (!candidate.quoted) {
                if (character === '[') candidate.depth++;
                if (character === ']' && --candidate.depth === 0) { completed = true; end = index + 1; break; }
            }
        }
        this.appendCandidate(data.slice(0, end));
        if (literal || completed) {
            const raw = candidate.parts.join('');
            this.candidate = null;
            if (literal || !candidate.name) this.emitText(events, raw);
            else {
                const match = raw.match(CALL);
                let input;
                try { input = JSON.parse(match?.[2]?.trim() || ''); }
                catch { throw kiroIntegrityError('invalid legacy tool argument JSON'); }
                if (!input || typeof input !== 'object' || Array.isArray(input)) throw kiroIntegrityError('legacy tool input must be a JSON object');
                const part = { type: 'tool', name: candidate.name, arguments: match[2].trim(), input };
                if (typeof events === 'function') events(part); else events.push(part);
                this.previousChar = ']';
            }
            return data.slice(end);
        }
        return '';
    }

    feed(text, onPart = null) {
        const events = onPart || [];
        let data = this.pending + text;
        this.pending = '';
        while (data) {
            if (this.candidate) {
                data = this.consumeCandidate(data, events);
                continue;
            }
            const index = data.indexOf(MARKER);
            if (index === -1) {
                let keep = 0;
                for (let length = 1; length < MARKER.length; length++) {
                    if (data.endsWith(MARKER.slice(0, length))) keep = length;
                }
                this.emitText(events, data.slice(0, data.length - keep));
                this.pending = keep ? data.slice(-keep) : '';
                break;
            }
            this.emitText(events, data.slice(0, index));
            this.flushDelimiter();
            data = data.slice(index + MARKER.length);
            if (this.codeDelimiter || this.literalQuote || ['"', "'", '`', '\\'].includes(this.previousChar)) {
                this.emitText(events, MARKER);
                continue;
            }
            this.candidate = { parts: [MARKER], header: MARKER, bytes: MARKER.length,
                name: null, depth: 1, quoted: false, escaped: false, trailingHigh: false };
        }
        return onPart ? [] : events;
    }

    finish() {
        const events = [];
        if (this.candidate) {
            if (this.candidate.name) throw kiroIntegrityError('incomplete legacy tool call');
            this.emitText(events, this.candidate.parts.join(''));
            this.candidate = null;
        }
        this.emitText(events, this.pending);
        this.pending = '';
        return events;
    }
}
