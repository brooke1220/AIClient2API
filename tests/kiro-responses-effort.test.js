import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import '../src/converters/register-converters.js';
import { convertData } from '../src/convert/convert.js';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { collect, service } from './helpers/kiro-safety-fixtures.js';

const request = (model, effort) => ({ model, input: 'hello', reasoning: { effort } });
const convert = (body, provider = 'claude-kiro-oauth') =>
    convertData(body, 'request', 'openaiResponses-custom', provider);
const currentContent = payload => payload.conversationState.currentMessage.userInputMessage.content;

async function send(body, stream = false, provider = 'claude-kiro-oauth') {
    const converted = convert(body, provider);
    const backend = service();
    backend.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
    if (stream) await collect(backend.generateContentStream(converted.model, converted));
    else await backend.generateContent(converted.model, converted);
    return backend._requestWithBuilderEndpointRouting.mock.calls[0][1];
}

beforeEach(() => jest.clearAllMocks());

describe.each([false, true])('Responses effort through protocol dispatch and Kiro generation (stream=%s)', stream => {
    test.each([
        ...['low', 'medium', 'high', 'xhigh', 'max'].map(effort => [
            'claude-sonnet-4-6', effort, effort === 'xhigh' ? 'high' : effort, true
        ]),
        ...['low', 'medium', 'high', 'xhigh', 'max'].map(effort => [
            'claude-opus-4-7', effort, effort, true
        ]),
        ...['low', 'medium', 'high', 'xhigh', 'max'].map(effort => [
            'claude-opus-5-5', effort, effort, false
        ])
    ])('%s preserves %s as wire effort %s', async (model, effort, expected, hasToggle) => {
        const payload = await send(request(model, effort), stream);
        expect(payload.additionalModelRequestFields).toEqual({
            output_config: { effort: expected },
            ...(hasToggle ? { thinking: { type: 'adaptive' } } : {})
        });
        expect(currentContent(payload)).toBe('hello');
    });

    test('none sends only the native disabled control', async () => {
        const body = request('claude-sonnet-4-6', 'none');
        expect(convert(body)).not.toHaveProperty('reasoning_effort');
        const payload = await send(body, stream);
        expect(payload.additionalModelRequestFields).toEqual({ thinking: { type: 'disabled' } });
        expect(currentContent(payload)).toBe('hello');
    });

    test.each([['low', 2048], ['high', 20000], ['max', 24576]])(
        'legacy models retain the %s budget as %s tokens', async (effort, budget) => {
            const payload = await send(request('claude-sonnet-4-5', effort), stream);
            expect(payload.additionalModelRequestFields).toBeUndefined();
            expect(currentContent(payload)).toBe(
                `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>\n\nhello`
            );
        }
    );
});

describe('Responses effort conversion boundaries', () => {
    test('normalizes effort for a named Kiro provider without mutating the source', async () => {
        const body = Object.freeze({
            ...request('claude-opus-4-7', ' HIGH '),
            reasoning: Object.freeze({ effort: ' HIGH ' })
        });
        const provider = 'claude-kiro-oauth-secondary';
        expect(convert(body, provider).reasoning_effort).toBe('high');
        const payload = await send(body, false, provider);
        expect(payload.additionalModelRequestFields.output_config.effort).toBe('high');
        expect(body.reasoning.effort).toBe(' HIGH ');
    });

    test.each([undefined, {}, { effort: '' }, { effort: '  ' }])(
        'absent effort %p leaves thinking unset', reasoning => {
            const converted = convert({ model: 'claude-sonnet-4-6', input: 'hello', reasoning });
            expect(converted).not.toHaveProperty('reasoning_effort');
            expect(converted).not.toHaveProperty('thinking');
        }
    );

    test('the Kiro mapper still owns the unknown-effort fallback', async () => {
        const payload = await send(request('claude-opus-4-7', 'unsupported'));
        expect(payload.additionalModelRequestFields).toEqual({
            output_config: { effort: 'medium' }, thinking: { type: 'adaptive' }
        });
    });

    test('ordinary Claude conversion keeps the existing budget without a Kiro-only field', () => {
        const converted = convert(request('claude-sonnet-4-6', 'high'), 'claude-custom');
        expect(converted.thinking).toEqual({ type: 'enabled', budget_tokens: 20000 });
        expect(converted).not.toHaveProperty('reasoning_effort');
    });
});
