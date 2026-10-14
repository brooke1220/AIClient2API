// Kiro's tool-result union accepts text/json, not Anthropic image blocks. Images
// belong on the enclosing userInputMessage; result text records their association.
export const DEFAULT_KIRO_HISTORY_IMAGE_MESSAGE_WINDOW = 5;

export function getKiroHistoryImageMessageWindow(config = {}) {
    const value = config.KIRO_HISTORY_IMAGE_MESSAGE_WINDOW;
    const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
        ? Number(value) : NaN;
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_KIRO_HISTORY_IMAGE_MESSAGE_WINDOW;
}

const IMAGE_FORMATS = new Map([
    ['image/png', 'png'], ['image/jpeg', 'jpeg'], ['image/jpg', 'jpeg'],
    ['image/gif', 'gif'], ['image/webp', 'webp']
]);

function convertImage(block) {
    let mediaType;
    let data;
    if (block.type === 'image') {
        if (block.source?.type === 'url') return { reason: 'URL images are not supported; provide base64 data' };
        if (block.source?.type && block.source.type !== 'base64') return { reason: 'unsupported image source' };
        mediaType = block.source?.media_type;
        data = block.source?.data;
    } else {
        const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
        const match = typeof url === 'string' && url.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
        if (!match) return { reason: 'URL images are not supported; provide a base64 data URL' };
        [, mediaType, data] = match;
    }
    const format = typeof mediaType === 'string' && IMAGE_FORMATS.get(mediaType.toLowerCase());
    if (!format) return { reason: 'missing or unsupported image media type' };
    if (typeof data !== 'string' || !data.trim()) return { reason: 'missing image data' };
    return { image: { format, source: { bytes: data } } };
}

function appendNote(text, note) {
    return text ? `${text}\n${note}` : note;
}

function extractContent(content, { keepImages, imageOffset = 0, inToolResult = false, toolUseId } = {}) {
    const result = { text: '', images: [], toolResults: [], imageCount: 0, omittedImageCount: 0, unsupportedImageCount: 0 };
    const seenToolIds = new Set();
    const attachedNumbers = [];
    const unsupportedReasons = new Set();
    // Notes are collected and appended after the loop: appending inline would run
    // a note together with the next text block ("...not forwarded.]please look").
    const unsupportedKinds = [];
    let directImageCount = 0;
    let directOmittedCount = 0;
    let directUnsupportedCount = 0;
    const blocks = Array.isArray(content) ? content : content == null ? [] : [content];

    for (const block of blocks) {
        if (typeof block === 'string') {
            result.text += block;
        } else if (block?.type === 'text' || (inToolResult && !block?.type && typeof block?.text === 'string')) {
            result.text += typeof block.text === 'string' ? block.text : '';
        } else if (block?.type === 'image' || block?.type === 'image_url') {
            directImageCount++;
            result.imageCount++;
            if (!keepImages) {
                directOmittedCount++;
                result.omittedImageCount++;
                continue;
            }
            const converted = convertImage(block);
            if (converted.image) {
                result.images.push(converted.image);
                attachedNumbers.push(imageOffset + result.images.length);
            } else {
                directUnsupportedCount++;
                result.unsupportedImageCount++;
                unsupportedReasons.add(converted.reason);
            }
        } else if (block?.type === 'tool_result' && !inToolResult) {
            // Keep the existing first-result-wins policy, before extracting images:
            // a duplicate result must not leave orphan images on the user message.
            if (seenToolIds.has(block.tool_use_id)) continue;
            seenToolIds.add(block.tool_use_id);
            const toolContent = extractContent(block.content, {
                keepImages, imageOffset: imageOffset + result.images.length,
                inToolResult: true, toolUseId: block.tool_use_id
            });
            const failed = block.is_error === true;
            result.toolResults.push({
                // NOTE: 'error' is not yet verified against a live upstream; this code previously
                // always sent 'success'. If failed tool calls start returning 400, suspect this
                // literal first. When a failure carries text, `status` is the only failure signal,
                // so swapping it back to 'success' would need a textual marker to replace it.
                content: [{ text: failed && !toolContent.text.trim()
                    ? 'Tool execution failed (no error details provided).' : toolContent.text }],
                status: failed ? 'error' : 'success',
                toolUseId: block.tool_use_id
            });
            result.images.push(...toolContent.images);
            result.imageCount += toolContent.imageCount;
            result.omittedImageCount += toolContent.omittedImageCount;
            result.unsupportedImageCount += toolContent.unsupportedImageCount;
        } else {
            unsupportedKinds.push(typeof block?.type === 'string' ? block.type.slice(0, 64) : 'unknown');
        }
    }

    for (const kind of unsupportedKinds) {
        result.text = appendNote(result.text, `[Unsupported ${inToolResult ? 'tool result ' : ''}content block "${kind}" was not forwarded.]`);
    }

    if (inToolResult && directImageCount > 0) {
        const details = [];
        if (attachedNumbers.length) details.push(`${attachedNumbers.length} attached to this message as image(s) ${attachedNumbers.join(', ')}`);
        if (directOmittedCount) details.push(`${directOmittedCount} omitted from older conversation history`);
        if (directUnsupportedCount) details.push(`${directUnsupportedCount} not forwarded (${[...unsupportedReasons].join('; ')})`);
        result.text = appendNote(result.text, `[Tool ${toolUseId} returned ${directImageCount} image(s): ${details.join('; ')}.]`);
    } else if (!inToolResult) {
        if (directOmittedCount) result.text = appendNote(result.text, `[此消息包含 ${directOmittedCount} 张图片，已在历史记录中省略]`);
        if (directUnsupportedCount) result.text = appendNote(result.text, `[${directUnsupportedCount} image(s) not forwarded: ${[...unsupportedReasons].join('; ')}.]`);
    }
    return result;
}

/** Convert user content without mutating the caller or moving binary data into text. */
export function convertKiroUserContent(content, { keepImages = true } = {}) {
    return extractContent(content, { keepImages });
}

/** Count only images that survived conversion and optional payload-history trimming. */
export function getKiroImagePayloadStats(payload) {
    const state = payload.conversationState;
    const messages = [...(state?.history || []), state?.currentMessage];
    let imageCount = 0;
    let imageBase64Bytes = 0;
    for (const entry of messages) {
        for (const image of entry?.userInputMessage?.images || []) {
            imageCount++;
            if (typeof image.source?.bytes === 'string') imageBase64Bytes += Buffer.byteLength(image.source.bytes);
        }
    }
    return { imageCount, imageBase64Bytes };
}
