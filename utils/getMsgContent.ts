// Minimal Telegram bot shape we depend on for file downloads.
interface TelegramFileBot {
    telegram: {
        getFile(fileId: string): Promise<{ file_path: string; file_size?: number }>;
    };
}

/**
 * Download a file's bytes from Telegram by file_id.
 */
export async function downloadTelegramFile(bot: TelegramFileBot, fileId: string): Promise<Buffer> {
    const token = process.env['BOT_TOKEN'];
    if (!token) throw new Error('Missing required environment variable: BOT_TOKEN');

    try {
        console.log(`Starting download for file: ${fileId}`);

        const file = await bot.telegram.getFile(fileId);
        console.log(`File info: ${file.file_path}, size: ${file.file_size} bytes`);

        const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        console.log(`Downloading from: ${fileUrl.replace(token, 'BOT_TOKEN')}`);

        const response = await fetch(fileUrl, {
            method: 'GET',
            headers: { 'User-Agent': 'Florence-Bot/1.0' },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        console.log(`Downloaded ${buffer.byteLength} bytes`);

        return Buffer.from(buffer);
    } catch (error) {
        console.error('Download error:', error);
        throw new Error(`File download failed: ${(error as Error).message}`);
    }
}
