import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import '../src/converters/register-converters.js';
import { convertData } from '../src/convert/convert.js';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { getKiroImagePayloadStats } from '../src/providers/claude/kiro-message-content.js';
import { countTokensAnthropic, ESTIMATED_IMAGE_TOKENS } from '../src/utils/token-utils.js';
import { model, service, text, collect } from './helpers/kiro-safety-fixtures.js';

const DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9FcAAAAASUVORK5CYII=';
const CALL_ID = 'call_capture';
const image = (data = DATA) => ({ type: 'input_image', image_url: `data:image/png;base64,${data}` });
const claudeImage = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATA } });
const kiroImage = () => ({ format: 'png', source: { bytes: DATA } });
const message = (role, content) => ({ type: 'message', role, content });
const call = (id = CALL_ID) => ({ type: 'function_call', call_id: id, name: 'capture', arguments: '{}' });
const result = (output, id = CALL_ID) => ({ type: 'function_call_output', call_id: id, output });

function request(output, historical = false) {
    return {
        model,
        input: [message('user', 'Capture the screen'), call(), result(output),
            ...(historical ? [message('assistant', 'Captured'), message('user', 'Inspect it')] : [])],
        tools: [{ type: 'function', name: 'capture', description: 'Capture the screen', parameters: { type: 'object', properties: {} } }]
    };
}

// Use the same protocol dispatch as the HTTP gateway, not a direct Kiro-only input.
function convert(body) {
    return convertData(body, 'request', 'openaiResponses-custom', 'claude-kiro-oauth');
}

function backend(config = {}) {
    const value = service([text('answer')], config);
    value.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
    value.estimateInputTokens = KiroApiService.prototype.estimateInputTokens;
    return value;
}

async function build(body, config = {}) {
    const converted = convert(body);
    return backend(config).buildCodewhispererRequest(converted.messages, model, converted.tools, converted.system);
}

function resultUser(payload, historical = false) {
    return historical
        ? payload.conversationState.history.find(entry => entry.userInputMessage?.userInputMessageContext?.toolResults)?.userInputMessage
        : payload.conversationState.currentMessage.userInputMessage;
}

function freezeDeep(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freezeDeep);
        Object.freeze(value);
    }
    return value;
}

beforeEach(() => jest.clearAllMocks());

describe('Responses tool output through protocol dispatch', () => {
    test('preserves an image-only output as a Claude image block', () => {
        const converted = convert(request([image()]));
        expect(converted.messages[2].content).toEqual([
            { type: 'tool_result', tool_use_id: CALL_ID, content: [claudeImage()] }
        ]);
    });

    test.each([
        { type: 'input_image', image_url: { url: `data:image/png;base64,${DATA}` } },
        { type: 'image_url', image_url: `data:image/png;base64,${DATA}` },
        { type: 'input_image', image_url: `DATA:IMAGE/PNG;BASE64,${DATA}` }
    ])('normalizes supported image URL shape %p', output => {
        const content = convert(request([output])).messages[2].content[0].content;
        expect(content[0]).toMatchObject({ type: 'image', source: { type: 'base64', data: DATA } });
        expect(content[0].source.media_type.toLowerCase()).toBe('image/png');
    });

    test('retains mixed text and images in order', () => {
        const output = [{ type: 'input_text', text: 'before' }, image(), { type: 'input_text', text: 'after' }];
        expect(convert(request(output)).messages[2].content[0].content).toEqual([
            { type: 'text', text: 'before' }, claudeImage(), { type: 'text', text: 'after' }
        ]);
    });

    test.each([
        ['plain text', 'plain text'], ['', ''], [null, ''], [undefined, ''],
        [{ answer: 42 }, '{"answer":42}'], [[1, { answer: 42 }], '[1,{"answer":42}]'], [[], '[]'],
        [JSON.stringify([image()]), JSON.stringify([image()])]
    ])('keeps the legacy non-content-block output %p', (output, expected) => {
        expect(convert(request(output)).messages[2].content[0].content).toBe(expected);
    });

    test('keeps typed text-array output as text rather than JSON syntax', () => {
        const content = convert(request([{ type: 'input_text', text: 'first' }, { type: 'input_text', text: 'second' }])).messages[2].content[0].content;
        expect(content).toEqual([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]);
    });

    test('preserves remote image sources without fetching them during conversion', () => {
        const url = 'https://example.invalid/screenshot.png';
        expect(convert(request([{ type: 'input_image', image_url: url }])).messages[2].content[0].content).toEqual([
            { type: 'image', source: { type: 'url', url } }
        ]);
    });

    test.each([
        { type: 'input_image', file_id: 'file_screenshot' },
        { type: 'input_image', image_url: `data:image/png,${DATA}` },
        { type: 'input_image' },
        { type: 'input_file', filename: 'capture.pdf', file_data: `data:application/pdf;base64,${DATA}` }
    ])('acknowledges unsupported output %p without binary text', output => {
        const content = convert(request([output])).messages[2].content[0].content;
        expect(content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('not forwarded') })]);
        expect(JSON.stringify(content)).not.toContain(DATA);
    });

    test('does not dump unknown binary blocks from a multimodal output into text', () => {
        const content = convert(request([image(), { type: 'custom_binary', data: DATA }])).messages[2].content[0].content;
        expect(content[0]).toEqual(claudeImage());
        expect(content[1]).toEqual({ type: 'text', text: '[Unsupported tool output content block "custom_binary" was not forwarded.]' });
        expect(content[1].text).not.toContain(DATA);
    });

    test('does not mutate deeply frozen request data', async () => {
        const body = freezeDeep(request([{ type: 'input_text', text: 'captured' }, image()]));
        const before = JSON.stringify(body);
        expect(resultUser(await build(body)).images).toEqual([kiroImage()]);
        expect(JSON.stringify(body)).toBe(before);
    });
});

describe('Responses conversion followed by the real Kiro request builder', () => {
    test.each([false, true])('retains images on the historical=%p path and sends binary only once', async historical => {
        const body = request([{ type: 'input_text', text: 'captured' }, image()], historical);
        const user = resultUser(await build(body), historical);
        expect(user.images).toEqual([kiroImage()]);
        expect(user.userInputMessageContext.toolResults[0]).toMatchObject({ status: 'success', toolUseId: CALL_ID });
        const resultText = user.userInputMessageContext.toolResults[0].content[0].text;
        expect(resultText).toContain('captured');
        expect(resultText).toContain('image(s) 1');
        expect(resultText).not.toContain(DATA);
        expect(JSON.stringify(user).split(DATA)).toHaveLength(2);
    });

    test.each([[0, false], [1, false], [2, true]])('respects history image window %i after protocol conversion', async (window, kept) => {
        const user = resultUser(await build(request([image()], true), { KIRO_HISTORY_IMAGE_MESSAGE_WINDOW: window }), true);
        expect(!!user.images?.length).toBe(kept);
        if (!kept) expect(user.userInputMessageContext.toolResults[0].content[0].text).toContain('omitted from older conversation history');
    });

    test('window zero still retains current tool images', async () => {
        const user = resultUser(await build(request([image()]), { KIRO_HISTORY_IMAGE_MESSAGE_WINDOW: 0 }));
        expect(user.images).toEqual([kiroImage()]);
    });

    test('associates parallel tool images with their enclosing message image indices', async () => {
        const body = request([image()]);
        body.input = [message('user', 'Capture the screen'), call(), call('call_second'),
            message('user', [image()]), result([image()]), result([image()], 'call_second')];
        const user = resultUser(await build(body));
        expect(user.images).toEqual([kiroImage(), kiroImage(), kiroImage()]);
        const results = user.userInputMessageContext.toolResults;
        expect(results.map(part => part.toolUseId)).toEqual([CALL_ID, 'call_second']);
        expect(results[0].content[0].text).toContain('image(s) 2');
        expect(results[1].content[0].text).toContain('image(s) 3');
    });

    test('deduplicates repeated tool outputs without orphan images', async () => {
        const body = request([image()]);
        body.input.push(result([image()]));
        const user = resultUser(await build(body));
        expect(user.images).toEqual([kiroImage()]);
        expect(user.userInputMessageContext.toolResults).toHaveLength(1);
    });

    test('keeps URL images explicit in Kiro rather than silently dropping them', async () => {
        const user = resultUser(await build(request([{ type: 'input_image', image_url: 'https://example.invalid/screenshot.png' }])));
        expect(user.images).toBeUndefined();
        const resultText = user.userInputMessageContext.toolResults[0].content[0].text;
        expect(resultText).toContain('not forwarded');
        expect(resultText).toContain('URL images are not supported');
    });

    test('counts tool images in token estimates after conversion', () => {
        const body = convert(request([image()]));
        const textOnly = convert(request(''));
        expect(countTokensAnthropic(body).input_tokens - countTokensAnthropic(textOnly).input_tokens).toBe(ESTIMATED_IMAGE_TOKENS);
        expect(backend().estimateInputTokens(body) - backend().estimateInputTokens(textOnly)).toBe(ESTIMATED_IMAGE_TOKENS);
    });

    test('includes converted tool images in the payload byte budget', async () => {
        await expect(build(request([image(DATA.repeat(1000))]), { KIRO_MAX_PAYLOAD_BYTES: 3000 })).rejects.toMatchObject({ status: 413 });
    });

    test.each(['unary', 'stream'])('%s generation transports the converted image structure', async mode => {
        const value = backend();
        const body = convert(request([image()]));
        if (mode === 'stream') {
            const events = await collect(value.generateContentStream(model, body));
            expect(events.find(event => event.type === 'message_start').message.usage.input_tokens).toBeGreaterThanOrEqual(ESTIMATED_IMAGE_TOKENS);
        } else {
            const response = await value.generateContent(model, body);
            expect(response.content).toEqual([{ type: 'text', text: 'answer' }]);
        }
        expect(value._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
        const sent = value._requestWithBuilderEndpointRouting.mock.calls[0][1];
        expect(resultUser(sent).images).toEqual([kiroImage()]);
        expect(getKiroImagePayloadStats(sent)).toEqual({ imageCount: 1, imageBase64Bytes: DATA.length });
        expect(resultUser(sent).userInputMessageContext.toolResults[0].content[0].text).not.toContain(DATA);
    });
});
