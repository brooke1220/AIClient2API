import { countTokens } from '@anthropic-ai/tokenizer';
import { countTextTokens, disposeTokenizer, warmupTokenizer } from '../src/utils/token-utils.js';

afterAll(disposeTokenizer);

test('reused tokenizer exactly preserves the package counts across normalization and Unicode', () => {
    const cases = [
        '', 'hello', '中文和 English 混合\n第二行', 'ﬃ ＡＢＣ ① e\u0301 é',
        '👨‍👩‍👧‍👦 🇨🇳 🟢', '\ud800', '\udfff', '\u0000\r\n\t',
        '<|endoftext|><|im_start|>assistant<|im_sep|>',
        JSON.stringify({ name: 'write_file', input: { path: '中文.js', content: 'const x = 1;\n' } }),
        'function hello() { return "你好"; }\n'.repeat(300)
    ];
    let seed = 17;
    const alphabet = ['a', ' ', '\n', '中', 'é', '\u0301', 'ﬃ', '🟢', '\ud800', '\udfff', '0', '{', '}'];
    for (let n = 0; n < 24; n++) {
        let value = '';
        for (let i = 0; i < 50 + n * 7; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            value += alphabet[seed % alphabet.length];
        }
        cases.push(value);
    }
    warmupTokenizer();
    for (const value of cases) expect(countTextTokens(value)).toBe(countTokens(value));
    // Shutdown/disposal is idempotent; later use can initialize again.
    disposeTokenizer();
    disposeTokenizer();
    expect(countTextTokens(cases[2])).toBe(countTokens(cases[2]));
});
