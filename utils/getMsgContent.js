/**
 * Extracts the content and type of a Telegram message
 * @param {Object} ctx - Telegram context object
 * @returns {Object} - Contains type, content, and additional metadata
 */
export function getMessageContent(ctx) {
    // Default result structure
    const result = {
        type: 'unknown',
        content: null,
        extension: null,
        mimeType: null,
        fileId: null,
        fileName: null
    };

    // Check for text message
    if (ctx.message.text) {
        result.type = 'text';
        result.content = ctx.message.text;
        return result;
    }

    // Check for photo
    if (ctx.message.photo) {
        // Photos come in an array of different sizes, get the largest one
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        result.type = 'photo';
        result.fileId = photo.file_id;
        result.extension = 'jpg'; // Telegram sends photos in JPEG format
        result.mimeType = 'image/jpeg';
        result.caption = ctx.message.caption || null;
        return result;
    }

    // Check for document/file
    if (ctx.message.document) {
        const doc = ctx.message.document;
        result.type = 'document';
        result.fileId = doc.file_id;
        result.fileName = doc.file_name;
        result.mimeType = doc.mime_type;
        result.caption = ctx.message.caption || null;

        // Extract file extension
        if (doc.file_name) {
            const parts = doc.file_name.split('.');
            if (parts.length > 1) {
                result.extension = parts[parts.length - 1].toLowerCase();
            }
        }

        // Try to determine more specific type based on MIME type or extension
        if (doc.mime_type) {
            if (doc.mime_type.startsWith('image/')) {
                result.type = 'image';
            } else if (doc.mime_type.startsWith('video/')) {
                result.type = 'video';
            } else if (doc.mime_type.startsWith('audio/')) {
                result.type = 'audio';
            } else if (doc.mime_type === 'application/pdf') {
                result.type = 'pdf';
            }
        }

        return result;
    }

    // Check for video
    if (ctx.message.video) {
        result.type = 'video';
        result.fileId = ctx.message.video.file_id;
        result.mimeType = ctx.message.video.mime_type;
        result.caption = ctx.message.caption || null;

        // Extract extension from MIME type
        if (result.mimeType) {
            result.extension = result.mimeType.split('/')[1];
        }

        return result;
    }

    // Check for audio
    if (ctx.message.audio) {
        result.type = 'audio';
        result.fileId = ctx.message.audio.file_id;
        result.mimeType = ctx.message.audio.mime_type;
        result.caption = ctx.message.caption || null;

        // Extract extension from MIME type
        if (result.mimeType) {
            result.extension = result.mimeType.split('/')[1];
        }

        return result;
    }

    // Check for voice message
    if (ctx.message.voice) {
        result.type = 'voice';
        result.fileId = ctx.message.voice.file_id;
        result.mimeType = 'audio/ogg'; // Voice messages in Telegram are typically OGG
        result.extension = 'ogg';
        return result;
    }

    // Check for sticker
    if (ctx.message.sticker) {
        result.type = 'sticker';
        result.fileId = ctx.message.sticker.file_id;
        result.mimeType = ctx.message.sticker.is_animated ? 'application/x-tgsticker' : 'image/webp';
        result.extension = ctx.message.sticker.is_animated ? 'tgs' : 'webp';
        return result;
    }

    // Check for location
    if (ctx.message.location) {
        result.type = 'location';
        result.content = {
            latitude: ctx.message.location.latitude,
            longitude: ctx.message.location.longitude
        };
        return result;
    }

    // Check for contact
    if (ctx.message.contact) {
        result.type = 'contact';
        result.content = {
            phoneNumber: ctx.message.contact.phone_number,
            firstName: ctx.message.contact.first_name,
            lastName: ctx.message.contact.last_name,
            userId: ctx.message.contact.user_id
        };
        return result;
    }

    // Return the default 'unknown' if nothing matched
    return result;
}

/**
 * Helper function to download file content from Telegram
 * @param {Object} bot - Telegraf bot instance
 * @param {string} fileId - File ID to download
 * @returns {Promise<Buffer>} - File content as buffer
 */
export async function downloadTelegramFile(bot, fileId) {
    try {
        console.log(`📥 Starting download for file: ${fileId}`);

        // Get file info first
        const file = await bot.telegram.getFile(fileId);
        console.log(`📄 File info: ${file.file_path}, size: ${file.file_size} bytes`);

        // Use the file path directly with bot token
        const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
        console.log(`🔗 Downloading from: ${fileUrl.replace(process.env.BOT_TOKEN, 'BOT_TOKEN')}`);

        // Download with improved settings (timeout removed)
        const response = await fetch(fileUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'Florence-Bot/1.0'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        console.log(`✅ Downloaded ${buffer.byteLength} bytes`);

        return Buffer.from(buffer);

    } catch (error) {
        console.error('❌ Download error:', error);
        throw new Error(`File download failed: ${error.message}`);
    }
}