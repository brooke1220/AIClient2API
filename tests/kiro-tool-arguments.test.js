import { hasKiroToolArguments, KiroToolAssembler } from '../src/providers/claude/kiro-tool-assembler.js';

describe('Kiro meaningful tool arguments', () => {
    test.each(['', ' ', '\n  \t\r', '{}', ' \n{ \t }\r ', {}, null, undefined])(
        'does not classify an empty placeholder as arguments: %p', input => {
            expect(hasKiroToolArguments(input)).toBe(false);
        }
    );

    test.each(['{', '  {"path":', '{"path":"x"}', { path: 'x' }])(
        'recognizes meaningful complete or partial arguments: %p', input => {
            expect(hasKiroToolArguments(input)).toBe(true);
        }
    );

    test('leading whitespace does not start parameter timing or change assembled arguments', () => {
        let now = 10;
        const assembler = new KiroToolAssembler(undefined, undefined, () => now);
        assembler.feed({ toolUseId: 'a', name: 'write_file', input: '\n  ' });
        expect(assembler.traceFor('a')).not.toHaveProperty('firstArgsMs');

        now = 1000;
        assembler.feed({ toolUseId: 'a', input: '{"path":' });
        now = 1200;
        const [call] = assembler.feed({ toolUseId: 'a', input: '"x"}', stop: true });

        expect(call.arguments).toBe('\n  {"path":"x"}');
        expect(call.input).toEqual({ path: 'x' });
        expect(assembler.traceFor('a')).toMatchObject({ firstArgsMs: 1000, validatedMs: 1200,
            identityMs: 10, identityReadyAtArgs: true });
    });

    test('whitespace followed by an empty object never claims a first parameter time', () => {
        const assembler = new KiroToolAssembler(undefined, undefined, () => 10);
        assembler.feed({ toolUseId: 'a', name: 'noop', input: '\n  ' });
        const [call] = assembler.feed({ toolUseId: 'a', input: '{}', stop: true });

        expect(call.input).toEqual({});
        expect(assembler.traceFor('a')).not.toHaveProperty('firstArgsMs');
    });
});
