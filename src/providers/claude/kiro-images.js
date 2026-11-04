let sharpModule;
async function imageProcessor() {
    sharpModule ||= import('sharp').then(module => module.default).catch(() => {
        sharpModule = null;
        throw Object.assign(new Error('Kiro image processor unavailable; install dependencies for the current platform'), {
            status: 503, code: 'KIRO_IMAGE_PROCESSOR_UNAVAILABLE', skipErrorCount: true, shouldSwitchCredential: false
        });
    });
    return sharpModule;
}

function imageError(message, status = 400) {
    return Object.assign(new Error(`Kiro image: ${message}`), {
        status, code: 'KIRO_IMAGE_INVALID', skipErrorCount: true, shouldSwitchCredential: false
    });
}
function positive(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function detectFormat(bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
    if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return null;
}

/** Decode only supported raster formats; bound both decompression and wire size. */
export async function normalizeKiroImages(payload, config = {}, signal) {
    const maxSource = positive(config.KIRO_IMAGE_MAX_SOURCE_BYTES, 10 * 1024 * 1024);
    const maxPixels = positive(config.KIRO_IMAGE_MAX_PIXELS, 40_000_000);
    const maxEdge = positive(config.KIRO_IMAGE_MAX_EDGE, 1568);
    const maxBase64 = positive(config.KIRO_IMAGE_MAX_BASE64_BYTES, 400_000);
    const messages = [...(payload.conversationState?.history || []), payload.conversationState?.currentMessage];
    for (const message of messages) for (const image of message?.userInputMessage?.images || []) {
        signal?.throwIfAborted();
        const encoded = image.source?.bytes;
        if (typeof encoded !== 'string' || encoded.length > Math.ceil(maxSource / 3) * 4 + 4) {
            throw imageError('source exceeds the configured byte limit', 413);
        }
        // Buffer.from is deliberately forgiving; reject junk instead of silently changing it.
        if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw imageError('invalid base64 data');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length > maxSource) throw imageError('source exceeds the configured byte limit', 413);
        const format = detectFormat(bytes);
        if (!format) throw imageError('unsupported or unrecognized raster format');
        const sharp = await imageProcessor();
        signal?.throwIfAborted();
        try {
            // 'error' rejects truncated/corrupt data but accepts recoverable decoder warnings.
            const metadata = await sharp(bytes, { limitInputPixels: maxPixels, failOn: 'error' }).metadata();
            if (!metadata.width || !metadata.height || metadata.format !== format) throw imageError('invalid image dimensions or format');
            // Decode even small images so truncated/corrupt bodies do not reach upstream.
            const oriented = sharp(bytes, { limitInputPixels: maxPixels, failOn: 'error' }).rotate();
            const canonical = bytes.toString('base64');
            if (Math.max(metadata.width, metadata.height) <= maxEdge && canonical.length <= maxBase64) {
                await oriented.stats();
                image.format = format;
                image.source = { bytes: canonical };
                continue;
            }
            let edge = Math.min(maxEdge, Math.max(metadata.width, metadata.height));
            let result;
            for (let attempt = 0; attempt < 10; attempt++) {
                signal?.throwIfAborted();
                result = await oriented.clone().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
                    .flatten({ background: '#ffffff' }).jpeg({ quality: Math.max(45, 85 - attempt * 10) }).toBuffer();
                if (Math.ceil(result.length / 3) * 4 <= maxBase64) break;
                result = null;
                edge = Math.max(1, Math.floor(edge * 0.7));
            }
            if (!result) throw imageError('cannot fit image into the configured output limit', 413);
            image.format = 'jpeg';
            image.source = { bytes: result.toString('base64') };
        } catch (error) {
            signal?.throwIfAborted();
            if (error.code === 'KIRO_IMAGE_INVALID') throw error;
            throw imageError('corrupt image or configured pixel limit exceeded');
        }
    }
    signal?.throwIfAborted();
    return payload;
}
