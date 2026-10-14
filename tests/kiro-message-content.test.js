import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import logger from '../src/utils/logger.js';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { convertKiroUserContent, getKiroHistoryImageMessageWindow, getKiroImagePayloadStats } from '../src/providers/claude/kiro-message-content.js';
import { guardKiroPayload } from '../src/providers/claude/kiro-request-guards.js';
import { model, service, text, collect } from './helpers/kiro-safety-fixtures.js';

const DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9FcAAAAASUVORK5CYII=';
const image = (data = DATA, media_type = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type, data } });
const toolResult = (content, options = {}) => ({ type: 'tool_result', tool_use_id: 'toolu_capture', content, ...options });
const kiroImage = (data = DATA, format = 'png') => ({ format, source: { bytes: data } });
const tools = [{ name: 'capture', description: 'Capture the screen', input_schema: { type: 'object', properties: {} } }];
const toolUse = () => ({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_capture', name: 'capture', input: {} }] });
const conversation = (content, historical = false) => [
    { role: 'user', content: 'Capture the screen' }, toolUse(), { role: 'user', content },
    ...(historical ? [{ role: 'assistant', content: 'Captured' }, { role: 'user', content: 'Inspect it' }] : [])
];
function backend(config = {}) {
    const value = service([text('answer')], config);
    value.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
    return value;
}
function resultUser(payload, historical = false) {
    return historical ? payload.conversationState.history.find(entry => entry.userInputMessage?.userInputMessageContext?.toolResults)?.userInputMessage
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

describe('shared Kiro user-content conversion', () => {
    test.each(['hello', [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }], ['hel', 'lo']])('plain text %p is preserved', content => {
        expect(convertKiroUserContent(content)).toMatchObject({ text: 'hello', images: [], toolResults: [], imageCount: 0 });
    });
    test.each([null, undefined, '', []])('empty content %p remains empty', content => {
        expect(convertKiroUserContent(content)).toMatchObject({ text: '', images: [], toolResults: [] });
    });
    test.each([['image/png', 'png'], ['image/jpeg', 'jpeg'], ['image/jpg', 'jpeg'], ['image/gif', 'gif'], ['image/webp', 'webp']])('%s normalizes to %s', (mime, format) => {
        expect(convertKiroUserContent([image(DATA, mime)]).images).toEqual([kiroImage(DATA, format)]);
    });
    test.each([`data:image/png;base64,${DATA}`, { url: `data:image/png;base64,${DATA}` }])('OpenAI image_url %p uses the same extraction path', image_url => {
        expect(convertKiroUserContent([{ type: 'image_url', image_url }]).images).toEqual([kiroImage()]);
    });
    test('image-only results attach real image data and explain the tool association', () => {
        const converted = convertKiroUserContent([toolResult([image()])]);
        expect(converted.images).toEqual([kiroImage()]);
        expect(converted.toolResults[0]).toMatchObject({ status: 'success', toolUseId: 'toolu_capture' });
        const text = converted.toolResults[0].content[0].text;
        expect(text).toContain('Tool toolu_capture returned 1 image(s)');
        expect(text).toContain('image(s) 1');
        expect(text).not.toContain(DATA);
    });
    test('an extra text property cannot hide an image block', () => {
        const converted = convertKiroUserContent([toolResult([{ ...image(), text: 'extra metadata' }])]);
        expect(converted.images).toEqual([kiroImage()]);
        expect(converted.toolResults[0].content[0].text).toContain('returned 1 image(s)');
    });
    test('legacy untyped text inside results is still accepted', () => {
        expect(convertKiroUserContent([toolResult([{ text: 'legacy text' }])]).toolResults[0].content).toEqual([{ text: 'legacy text' }]);
    });
    test('mixed text, direct images and parallel tool images retain order and association', () => {
        const converted = convertKiroUserContent([
            image('first'), toolResult([{ type: 'text', text: 'captured' }, image('second'), image('third')]),
            { type: 'text', text: 'inspect' }, toolResult([image('fourth')], { tool_use_id: 'toolu_other' })
        ]);
        expect(converted.text).toBe('inspect');
        expect(converted.images.map(part => part.source.bytes)).toEqual(['first', 'second', 'third', 'fourth']);
        expect(converted.toolResults[0].content[0].text).toContain('captured');
        expect(converted.toolResults[0].content[0].text).toContain('image(s) 2, 3');
        expect(converted.toolResults[1].content[0].text).toContain('image(s) 4');
    });
    test.each([true, false, undefined])('is_error=%p determines the status', is_error => {
        const converted = convertKiroUserContent([toolResult('execution details', { is_error })]);
        expect(converted.toolResults).toEqual([{ content: [{ text: 'execution details' }], status: is_error === true ? 'error' : 'success', toolUseId: 'toolu_capture' }]);
    });
    test.each(['', '   ', [], undefined])('failed empty result %p has explicit failure text', content => {
        const converted = convertKiroUserContent([toolResult(content, { is_error: true })]);
        expect(converted.toolResults[0]).toMatchObject({ status: 'error', content: [{ text: 'Tool execution failed (no error details provided).' }] });
    });
    test('success with an empty result remains a successful empty result', () => {
        expect(convertKiroUserContent([toolResult('')]).toolResults[0]).toEqual({ content: [{ text: '' }], status: 'success', toolUseId: 'toolu_capture' });
    });
    test('old tool images have a count and omission reason inside their result', () => {
        const converted = convertKiroUserContent([toolResult([image(), image()], { is_error: true })], { keepImages: false });
        expect(converted).toMatchObject({ images: [], imageCount: 2, omittedImageCount: 2 });
        expect(converted.toolResults[0]).toMatchObject({ status: 'error' });
        expect(converted.toolResults[0].content[0].text).toContain('2 image(s): 2 omitted from older conversation history');
    });
    test.each([
        { type: 'image', source: { type: 'url', url: 'https://example.invalid/screen.png' } },
        { type: 'image_url', image_url: { url: 'https://example.invalid/screen.png' } },
        { type: 'image' }, image('', 'image/png'), image(DATA, 'image/svg+xml'),
        { type: 'image', source: { data: DATA } },
        { type: 'image', source: { type: 'file', data: DATA, media_type: 'image/png' } }
    ])('unsupported image %p is explicit, not silently discarded or sent as invalid bytes', block => {
        const converted = convertKiroUserContent([toolResult([block])]);
        expect(converted).toMatchObject({ images: [], imageCount: 1, unsupportedImageCount: 1 });
        expect(converted.toolResults[0].content[0].text).toContain('1 not forwarded');
        expect(converted.toolResults[0].content[0].text).not.toContain(DATA);
    });
    test('supported and unsupported images in one result are accounted separately', () => {
        const converted = convertKiroUserContent([toolResult([image(), { type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } }])]);
        expect(converted.images).toEqual([kiroImage()]);
        expect(converted.toolResults[0].content[0].text).toContain('returned 2 image(s): 1 attached');
        expect(converted.toolResults[0].content[0].text).toContain('1 not forwarded');
    });
    test('unknown content is acknowledged without dumping binary data into text', () => {
        const converted = convertKiroUserContent([toolResult([{ type: 'document', source: { data: DATA } }, { type: 'custom_binary', data: DATA }])]);
        expect(converted.toolResults[0].content[0].text).toContain('"document" was not forwarded');
        expect(converted.toolResults[0].content[0].text).toContain('"custom_binary" was not forwarded');
        expect(converted.toolResults[0].content[0].text).not.toContain(DATA);
    });
    test.each([
        ['tool_use', [{ type: 'tool_use', id: 'toolu_x', name: 'capture', input: {} }, { type: 'text', text: 'please look' }]],
        ['thinking', [{ type: 'thinking', thinking: 'internal' }, { type: 'text', text: 'please look' }]]
    ])('an unsupported %s block never runs together with following text', (kind, content) => {
        const text = convertKiroUserContent(content).text;
        expect(text).toBe(`please look\n[Unsupported content block "${kind}" was not forwarded.]`);
        expect(text).not.toContain(']please');
    });
    test('omission and unsupported notes stay on their own lines around text', () => {
        const text = convertKiroUserContent([
            { type: 'video' }, image(), { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } }, { type: 'text', text: 'middle' }
        ], { keepImages: false }).text;
        expect(text.split('\n')[0]).toBe('middle');
        expect(text.split('\n').every(line => line === 'middle' || line.startsWith('['))).toBe(true);
    });
    test('duplicate tool IDs do not create duplicate results or orphan images', () => {
        const converted = convertKiroUserContent([toolResult([image('first')]), toolResult([image('discarded')], { is_error: true })]);
        expect(converted.toolResults).toHaveLength(1);
        expect(converted.toolResults[0].status).toBe('success');
        expect(converted.images).toEqual([kiroImage('first')]);
        expect(converted.imageCount).toBe(1);
    });
    test('conversion accepts deeply frozen caller data without mutation', () => {
        const content = freezeDeep([image(), toolResult([{ type: 'text', text: 'done' }, image()])]);
        const before = JSON.stringify(content);
        expect(convertKiroUserContent(content).images).toHaveLength(2);
        expect(JSON.stringify(content)).toBe(before);
    });
});

describe('Kiro history image-window configuration', () => {
    test.each([0, 1, 5, 8, '0', '8'])('nonnegative configuration %p is used', value => {
        expect(getKiroHistoryImageMessageWindow({ KIRO_HISTORY_IMAGE_MESSAGE_WINDOW: value })).toBe(Number(value));
    });
    test.each([undefined, null, '', ' ', true, false, -1, 1.5, 'bad', NaN, Infinity, [], {}])('invalid configuration %p falls back to 5', value => {
        expect(getKiroHistoryImageMessageWindow({ KIRO_HISTORY_IMAGE_MESSAGE_WINDOW: value })).toBe(5);
    });
});

describe('actual Kiro request-builder regression coverage', () => {
    test.each([false, true])('tool images and failures survive the historical=%p path', async historical => {
        const messages = freezeDeep(conversation([toolResult([{ type: 'text', text: 'capture failed' }, image()], { is_error: true })], historical));
        const payload = await backend().buildCodewhispererRequest(messages, model, tools);
        const user = resultUser(payload, historical);
        expect(user.images).toEqual([kiroImage()]);
        expect(user.userInputMessageContext.toolResults[0]).toMatchObject({ status: 'error', toolUseId: 'toolu_capture' });
        expect(user.userInputMessageContext.toolResults[0].content[0].text).toContain('capture failed');
        expect(user.userInputMessageContext.toolResults[0].content[0].text).toContain('image(s) 1');
        expect(user.content.trim()).not.toBe('');
        expect(payload.conversationState.history.at(-1)).toHaveProperty('assistantResponseMessage');
    });
    test.each([false, true])('duplicate results are consistently deduplicated on historical=%p path', async historical => {
        const payload = await backend().buildCodewhispererRequest(conversation([toolResult([image('first')]), toolResult([image('second')])], historical), model, tools);
        const user = resultUser(payload, historical);
        expect(user.userInputMessageContext.toolResults).toHaveLength(1);
        expect(user.images).toEqual([kiroImage('first')]);
    });
    test.each([[6, true], [7, false]])('first user image retains the old default boundary for %i processed messages', async (length, kept) => {
        const messages = Array.from({ length }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i === 0 ? [image()] : `turn ${i}` }));
        const payload = await backend().buildCodewhispererRequest(messages, model, tools);
        expect(!!payload.conversationState.history[0].userInputMessage.images?.length).toBe(kept);
        if (!kept) expect(payload.conversationState.history[0].userInputMessage.content).toContain('1 张图片');
    });
    test.each([[1, false], [2, true]])('historical tool images use the configured distance boundary %i', async (window, kept) => {
        const payload = await backend({ KIRO_HISTORY_IMAGE_MESSAGE_WINDOW: window }).buildCodewhispererRequest(conversation([toolResult([image()])], true), model, tools);
        const user = resultUser(payload, true);
        expect(!!user.images?.length).toBe(kept);
        if (!kept) expect(user.userInputMessageContext.toolResults[0].content[0].text).toContain('omitted from older conversation history');
    });
    test('window zero drops only history images, not current tool images', async () => {
        const messages = conversation([toolResult([image()])]);
        messages[0].content = [image()];
        const payload = await backend({ KIRO_HISTORY_IMAGE_MESSAGE_WINDOW: 0 }).buildCodewhispererRequest(messages, model, tools);
        expect(payload.conversationState.history[0].userInputMessage.images).toBeUndefined();
        expect(payload.conversationState.currentMessage.userInputMessage.images).toEqual([kiroImage()]);
    });
    test('window zero also preserves single-turn current images and system prompt', async () => {
        const payload = await backend({ KIRO_HISTORY_IMAGE_MESSAGE_WINDOW: 0 }).buildCodewhispererRequest([{ role: 'user', content: [image()] }], model, tools, 'custom system');
        const user = resultUser(payload);
        expect(payload.conversationState.history).toBeUndefined();
        expect(user.images).toEqual([kiroImage()]);
        expect(user.content).toContain('custom system');
    });
    test('first, intermediate and current messages all support base64 data URLs', async () => {
        const content = [{ type: 'image_url', image_url: `data:image/png;base64,${DATA}` }];
        const messages = [{ role: 'user', content }, { role: 'assistant', content: 'one' }, { role: 'user', content }, { role: 'assistant', content: 'two' }, { role: 'user', content }];
        const payload = await backend().buildCodewhispererRequest(messages, model, tools);
        expect(payload.conversationState.history.filter(entry => entry.userInputMessage).map(entry => entry.userInputMessage.images)).toEqual([[kiroImage()], [kiroImage()]]);
        expect(resultUser(payload).images).toEqual([kiroImage()]);
    });
    test('image distance is measured after empty-message filtering and same-role merging', async () => {
        const messages = [{ role: 'user', content: [image()] }, { role: 'user', content: 'same turn' }, { role: 'assistant', content: '' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'latest' }];
        const payload = await backend({ KIRO_HISTORY_IMAGE_MESSAGE_WINDOW: 2 }).buildCodewhispererRequest(messages, model, tools);
        expect(payload.conversationState.history[0].userInputMessage.images).toEqual([kiroImage()]);
    });
    test.each([false, true])('URL images fail gracefully on historical=%p path', async historical => {
        const payload = await backend().buildCodewhispererRequest(conversation([toolResult([{ type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } }])], historical), model, tools);
        const user = resultUser(payload, historical);
        expect(user.images).toBeUndefined();
        expect(user.userInputMessageContext.toolResults[0].content[0].text).toContain('not forwarded');
    });
    test('the final byte guard includes tool images instead of silently losing them', async () => {
        await expect(backend({ KIRO_MAX_PAYLOAD_BYTES: 3000 }).buildCodewhispererRequest(conversation([toolResult([image(DATA.repeat(1000))])]), model, tools)).rejects.toMatchObject({ status: 413 });
    });
    test.each([false, true])('an orphaned first-message tool result (is_error=%p) becomes text, never an unpaired toolResult', async is_error => {
        const messages = [
            { role: 'user', content: [toolResult('resumed output', { is_error })] },
            { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }
        ];
        const user = (await backend().buildCodewhispererRequest(messages, model, tools)).conversationState.history[0].userInputMessage;
        // history[0] has no preceding toolUses, so a toolResults field here would be orphaned.
        expect(user.userInputMessageContext).toBeUndefined();
        expect(user.content).toContain(`[Earlier tool result${is_error ? ' (error)' : ''} omitted from history]`);
        expect(user.content).toContain('resumed output');
    });
    test('an orphaned first-message tool result keeps its image and the image reference', async () => {
        const messages = [
            { role: 'user', content: [toolResult([{ type: 'text', text: 'screenshot taken' }, image()])] },
            { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }
        ];
        const user = (await backend().buildCodewhispererRequest(messages, model, tools)).conversationState.history[0].userInputMessage;
        expect(user.userInputMessageContext).toBeUndefined();
        expect(user.images).toEqual([kiroImage()]);
        expect(user.content).toContain('screenshot taken');
        expect(user.content).toContain('image(s) 1');
        expect(user.content).not.toContain(DATA);
    });
    test('a properly paired first-message tool result is still sent as a toolResult', async () => {
        const messages = [
            { role: 'user', content: 'start' }, toolUse(),
            { role: 'user', content: [toolResult('paired output')] },
            { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }
        ];
        const user = resultUser(await backend().buildCodewhispererRequest(messages, model, tools), true);
        expect(user.userInputMessageContext.toolResults[0]).toMatchObject({ toolUseId: 'toolu_capture', status: 'success' });
        expect(user.content).not.toContain('omitted from history');
    });
    test('an image-free request logs no image diagnostics', async () => {
        await backend().buildCodewhispererRequest([{ role: 'user', content: 'plain text' }], model, tools);
        expect(logger.info.mock.calls.flat().join(' ')).not.toContain('Converted request images');
    });
    test('diagnostic logs contain final image counts and byte sizes, never image content', async () => {
        const payload = await backend({ KIRO_HISTORY_IMAGE_MESSAGE_WINDOW: 0 }).buildCodewhispererRequest(conversation([image(), toolResult([image()])]), model, tools);
        expect(getKiroImagePayloadStats(payload)).toEqual({ imageCount: 2, imageBase64Bytes: 2 * DATA.length });
        expect(logger.info).toHaveBeenCalledWith(`[Kiro] Converted request images: 2; base64 payload: ${2 * DATA.length} bytes`);
        expect(logger.info.mock.calls.flat().join(' ')).not.toContain(DATA);
    });
    test.each(['unary', 'stream'])('%s generation sends the new image/result structure through the existing transport', async mode => {
        const value = backend();
        value.estimateInputTokens = KiroApiService.prototype.estimateInputTokens;
        const body = { messages: conversation([toolResult([image()], { is_error: true })]), tools };
        if (mode === 'stream') {
            const events = await collect(value.generateContentStream(model, body));
            expect(events.find(event => event.type === 'message_start').message.usage.input_tokens).toBeGreaterThanOrEqual(1600);
        } else {
            const response = await value.generateContent(model, body);
            expect(response.content).toEqual([{ type: 'text', text: 'answer' }]);
        }
        expect(value._requestWithBuilderEndpointRouting).toHaveBeenCalledTimes(1);
        const sent = value._requestWithBuilderEndpointRouting.mock.calls[0][1];
        const user = resultUser(sent);
        expect(user.images).toEqual([kiroImage()]);
        expect(user.userInputMessageContext.toolResults[0].status).toBe('error');
        expect(Object.keys(user.userInputMessageContext.toolResults[0].content[0])).toEqual(['text']);
        expect(JSON.stringify(sent).split(DATA)).toHaveLength(2); // base64 is sent once, as an image, not as text.
    });
    test('history-trimming fallback preserves an orphaned tool failure and its image reference', () => {
        const converted = convertKiroUserContent([toolResult([{ type: 'text', text: 'details' }, image()], { is_error: true })]);
        const payload = { conversationState: {
            history: [
                { userInputMessage: { content: 'system' } }, { assistantResponseMessage: { content: 'priming' } },
                { userInputMessage: { content: 'x'.repeat(2000) } }, { assistantResponseMessage: { content: 'old tool', toolUses: [{ toolUseId: 'toolu_capture' }] } },
                { userInputMessage: { content: 'result', images: converted.images, userInputMessageContext: { toolResults: converted.toolResults } } },
                { assistantResponseMessage: { content: 'latest' } }
            ], currentMessage: { userInputMessage: { content: 'current' } }
        } };
        const trimmed = guardKiroPayload(payload, { KIRO_MAX_PAYLOAD_BYTES: 1500, KIRO_TRIM_HISTORY: true });
        const user = trimmed.conversationState.history[2].userInputMessage;
        expect(user.userInputMessageContext.toolResults).toBeUndefined();
        expect(user.content).toContain('[Earlier tool result (error) omitted from history]');
        expect(user.content).toContain('image(s) 1');
        expect(user.images).toEqual([kiroImage()]);
        expect(payload.conversationState.history[4].userInputMessage.userInputMessageContext.toolResults[0].status).toBe('error');
    });
    test('diagnostics measure the final trimmed payload, not removed historical images', () => {
        const pair = (text, images) => [{ userInputMessage: { content: text, ...(images ? { images } : {}) } }, { assistantResponseMessage: { content: text } }];
        const payload = { conversationState: { history: [...pair('system'), ...pair('x'.repeat(2000), [kiroImage()]), ...pair('recent')], currentMessage: { userInputMessage: { content: 'latest', images: [kiroImage()] } } } };
        const trimmed = guardKiroPayload(payload, { KIRO_MAX_PAYLOAD_BYTES: 1500, KIRO_TRIM_HISTORY: true });
        expect(getKiroImagePayloadStats(payload).imageCount).toBe(2);
        expect(getKiroImagePayloadStats(trimmed)).toEqual({ imageCount: 1, imageBase64Bytes: DATA.length });
    });
});
