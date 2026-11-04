import { jest } from '@jest/globals';
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import sharp from 'sharp';
import { normalizeKiroImages } from '../src/providers/claude/kiro-images.js';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { service, model, request } from './helpers/kiro-safety-fixtures.js';

const payload = (...images) => ({ conversationState: { currentMessage: { userInputMessage: { images } } } });
const image = (bytes, format = 'png') => ({ format, source: { bytes: bytes.toString('base64') } });
let png;
beforeAll(async () => { png = await sharp({ create: { width: 20, height: 10, channels: 4, background: '#ff000080' } }).png().toBuffer(); });

test('actual format corrects the declared MIME and small images retain their bytes', async () => {
    const data = payload(image(png, 'jpeg'));
    await normalizeKiroImages(data);
    expect(data.conversationState.currentMessage.userInputMessage.images[0]).toEqual(image(png));
});

test('large noisy images fit both dimension and base64 byte ceilings', async () => {
    const input = Buffer.alloc(2200 * 1600 * 3);
    for (let i = 0; i < input.length; i++) input[i] = (i * 73 + (i >> 4) * 31) % 256;
    const bytes = await sharp(input, { raw: { width: 2200, height: 1600, channels: 3 } }).png().toBuffer();
    const data = payload(image(bytes));
    await normalizeKiroImages(data, { KIRO_IMAGE_MAX_EDGE: 800, KIRO_IMAGE_MAX_BASE64_BYTES: 30000 });
    const converted = data.conversationState.currentMessage.userInputMessage.images[0];
    const meta = await sharp(Buffer.from(converted.source.bytes, 'base64')).metadata();
    expect(converted.format).toBe('jpeg');
    expect(converted.source.bytes.length).toBeLessThanOrEqual(30000);
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(800);
    expect(meta.width / meta.height).toBeCloseTo(2200 / 1600, 1);
});

test.each(['not base64!', Buffer.from('<svg></svg>').toString('base64'), 'iVBORw0KGgo='])('malformed or non-raster data %p fails before transport', async encoded => {
    const backend = service(); backend.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
    const body = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: encoded } }] }] };
    await expect(backend.generateContent(model, body)).rejects.toMatchObject({ status: 400, code: 'KIRO_IMAGE_INVALID', skipErrorCount: true });
    expect(backend._requestWithBuilderEndpointRouting).not.toHaveBeenCalled();
});

test('recoverable decoder warnings pass, while truncated images are still rejected', async () => {
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888' } }).jpeg().toBuffer();
    const table = jpeg.indexOf(Buffer.from([0xff, 0xc4]));
    // libjpeg warns "extraneous bytes before marker" but decodes the image.
    const recoverable = Buffer.concat([jpeg.subarray(0, table), Buffer.from([0, 0, 0]), jpeg.subarray(table)]);
    const data = payload(image(recoverable, 'jpeg'));
    await normalizeKiroImages(data);
    expect(data.conversationState.currentMessage.userInputMessage.images[0]).toEqual(image(recoverable, 'jpeg'));
    await expect(normalizeKiroImages(payload(image(jpeg.subarray(0, jpeg.length - 20), 'jpeg'))))
        .rejects.toMatchObject({ status: 400, code: 'KIRO_IMAGE_INVALID' });
    await expect(normalizeKiroImages(payload(image(png.subarray(0, png.length - 30)))))
        .rejects.toMatchObject({ status: 400, code: 'KIRO_IMAGE_INVALID' });
});

test('source and decoded pixel limits reject oversized images without sending them', async () => {
    await expect(normalizeKiroImages(payload(image(png)), { KIRO_IMAGE_MAX_SOURCE_BYTES: 10 })).rejects.toMatchObject({ status: 413 });
    await expect(normalizeKiroImages(payload(image(png)), { KIRO_IMAGE_MAX_PIXELS: 100 })).rejects.toMatchObject({ status: 400 });
});

test('historical images use the same validation and cancellation is honored', async () => {
    const data = { conversationState: { history: [{ userInputMessage: { images: [image(png, 'webp')] } }] } };
    await normalizeKiroImages(data);
    expect(data.conversationState.history[0].userInputMessage.images[0].format).toBe('png');
    const controller = new AbortController(); controller.abort();
    await expect(normalizeKiroImages(payload(image(png)), {}, controller.signal)).rejects.toThrow(/abort/i);
});

test('missing tool descriptions use the name and preserve schema constraints', async () => {
    const backend = service(); backend.buildCodewhispererRequest = KiroApiService.prototype.buildCodewhispererRequest;
    const schema = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', minLength: 2, pattern: '^a' } }, required: ['text'] };
    const body = request();
    const data = await backend.buildCodewhispererRequest(body.messages, model, [{ name: 'lookup', input_schema: schema }]);
    expect(data.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification).toEqual({
        name: 'lookup', description: 'lookup', inputSchema: { json: schema }
    });
});
