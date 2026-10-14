import { countTokensAnthropic, estimateInputTokens, countTextTokens, ESTIMATED_IMAGE_TOKENS } from '../src/utils/token-utils.js';

const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image data is not text' } };
const request = content => ({ messages: [{ role: 'user', content }] });
const result = content => ({ type: 'tool_result', tool_use_id: 'toolu_test', content });

for (const [name, count] of [['countTokensAnthropic', body => countTokensAnthropic(body).input_tokens], ['estimateInputTokens', estimateInputTokens]]) {
    describe(`${name} multimodal estimates`, () => {
        test('top-level image gets the existing approximate image cost', () => {
            expect(count(request([image]))).toBe(ESTIMATED_IMAGE_TOKENS);
        });
        test('nested tool-result images are counted rather than silently missed', () => {
            expect(count(request([result([image, image])]))).toBe(2 * ESTIMATED_IMAGE_TOKENS);
        });
        test('mixed direct/nested images and text are counted once', () => {
            const content = [{ type: 'text', text: 'hello' }, image, result([{ type: 'text', text: 'world' }, image])];
            expect(count(request(content))).toBe(countTextTokens('helloworld') + 2 * ESTIMATED_IMAGE_TOKENS);
        });
        test('base64 data URLs also count as images', () => {
            expect(count(request([{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }]))).toBe(ESTIMATED_IMAGE_TOKENS);
        });
        test.each([
            { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } },
            { type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } },
            { type: 'image_url', image_url: 'https://example.invalid/a.png' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
            { type: 'image' }
        ])('image %p without inline data is not billed, since it is never forwarded', block => {
            expect(count(request([block]))).toBe(0);
            expect(count(request([result([block])]))).toBe(0);
        });
        test('a forwarded image is still billed next to an unforwardable one', () => {
            const url = { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } };
            expect(count(request([image, url]))).toBe(ESTIMATED_IMAGE_TOKENS);
        });
        test.each(['hello', [{ type: 'text', text: 'hello' }], [result('hello')]])('text-only %p keeps its previous estimate', content => {
            expect(count(request(content))).toBe(countTextTokens('hello'));
        });
        test.each([null, undefined, '', []])('empty content %p does not add media cost', content => {
            expect(count(request(content))).toBe(0);
        });
        test('a base64 document has the same estimate whether direct or in a result', () => {
            const document = { type: 'document', source: { type: 'base64', data: 'a'.repeat(100) } };
            const expected = Math.ceil(100 * 0.75 / 4);
            expect(count(request([document]))).toBe(expected);
            expect(count(request([result([document])]))).toBe(expected);
        });
        test('system text, tool schemas and tool input are still included', () => {
            const tools = [{ name: 'test', input_schema: { type: 'object' } }];
            const input = { value: 1 };
            const body = { ...request([{ type: 'tool_use', name: 'test', input }, result([image])]), system: 'system', tools };
            expect(count(body)).toBe(countTextTokens(`system${JSON.stringify(input)}${JSON.stringify(tools)}`) + ESTIMATED_IMAGE_TOKENS);
        });
    });
}

describe('thinking prefix remains part of the generation fallback estimate', () => {
    test('enabled thinking keeps its existing text-prefix overhead', () => {
        expect(estimateInputTokens({ ...request([image]), thinking: { type: 'enabled', budget_tokens: 2048 } })).toBe(countTextTokens('<thinking_mode>enabled</thinking_mode><max_thinking_length>2048</max_thinking_length>') + ESTIMATED_IMAGE_TOKENS);
    });
    test('adaptive thinking keeps its existing text-prefix overhead', () => {
        expect(estimateInputTokens({ ...request([image]), thinking: { type: 'adaptive', effort: 'low' } })).toBe(countTextTokens('<thinking_mode>adaptive</thinking_mode><thinking_effort>low</thinking_effort>') + ESTIMATED_IMAGE_TOKENS);
    });
});
