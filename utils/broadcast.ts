import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import { User } from '../models/user.js';
import { ensureConnection } from '../db/connection.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bot = new Telegraf(process.env['BOT_TOKEN'] ?? '');

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------
const BATCH_SIZE = 25; // concurrent sends per batch (stay under Telegram's 30/sec limit)
const MAX_RETRIES = 3; // retry attempts per user on transient errors
const RETRY_BASE_MS = 1000; // first retry waits 1s, second 2s, third 4s (exponential)
const BATCH_PAUSE_MS = 1000; // pause between batches (gives Telegram a breath)
// ---------------------------------------------------------------------------

const TRANSIENT_ERRORS = ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'];

interface BroadcastUser {
    userId: string;
    name: string;
}

interface SendResult {
    success: boolean;
    user?: BroadcastUser;
    telegramId?: string;
    error?: string;
    permanent?: boolean;
}

interface Payload {
    text: string; // message body, or the attachment caption
    filePath?: string; // optional attachment
}

function isTransient(error: NodeJS.ErrnoException): boolean {
    return TRANSIENT_ERRORS.some((code) => error.message?.includes(code) || error.code === code);
}

// Pick the right Telegram send method from the file extension.
function attachmentKind(filePath: string): 'photo' | 'video' | 'animation' | 'document' {
    const ext = path.extname(filePath).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return 'photo';
    if (ext === '.gif') return 'animation';
    if (['.mp4', '.mov', '.webm', '.m4v'].includes(ext)) return 'video';
    return 'document';
}

async function sendToUser(telegramId: string, payload: Payload): Promise<void> {
    if (payload.filePath) {
        const source = fs.createReadStream(payload.filePath);
        const caption = payload.text || undefined;
        const kind = attachmentKind(payload.filePath);
        if (kind === 'photo') await bot.telegram.sendPhoto(telegramId, { source }, { caption });
        else if (kind === 'video') await bot.telegram.sendVideo(telegramId, { source }, { caption });
        else if (kind === 'animation') await bot.telegram.sendAnimation(telegramId, { source }, { caption });
        else await bot.telegram.sendDocument(telegramId, { source }, { caption });
    } else {
        // Plain text on purpose: no parse_mode, so the message goes out exactly as
        // written with no MarkdownV2 escaping needed.
        await bot.telegram.sendMessage(telegramId, payload.text);
    }
}

async function sendWithRetry(user: BroadcastUser, payload: Payload): Promise<SendResult> {
    const telegramId = user.userId.replace('tg-', '');

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await sendToUser(telegramId, payload);
            return { success: true, user, telegramId };
        } catch (err) {
            const error = err as NodeJS.ErrnoException;
            const transient = isTransient(error);
            const lastAttempt = attempt === MAX_RETRIES;

            if (transient && !lastAttempt) {
                const waitMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
                console.warn(
                    `  [retry ${attempt}/${MAX_RETRIES}] ${user.name} — ${error.message} — waiting ${waitMs}ms`
                );
                await new Promise((r) => setTimeout(r, waitMs));
            } else {
                return { success: false, user, telegramId, error: error.message, permanent: !transient };
            }
        }
    }
    return { success: false, user, telegramId, error: 'unknown', permanent: true };
}

interface Args {
    message: string;
    filePath?: string;
    targetUserIds?: string;
}

function parseArgs(argv: string[]): Args {
    const positional: string[] = [];
    let filePath: string | undefined;
    let targetUserIds: string | undefined;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--file' || a === '-f') filePath = argv[++i];
        else if (a === '--to' || a === '-t') targetUserIds = argv[++i];
        else positional.push(a);
    }

    return { message: positional[0] ?? '', filePath, targetUserIds };
}

function usage(): void {
    console.log('Broadcast to Telegram users.\n');
    console.log('Usage: tsx utils/broadcast.ts "<message>" [--file <path>] [--to <id,id,...>]\n');
    console.log('Examples:');
    console.log('  tsx utils/broadcast.ts "Hello everyone"');
    console.log('  tsx utils/broadcast.ts "Caption for the image" --file assets/promo.jpg');
    console.log('  tsx utils/broadcast.ts "Read this" --file notice.pdf --to "123456789,987654321"');
    console.log('\nText is sent as-is (no Markdown). Attachment type is detected from the extension');
    console.log('(images, .gif, video, anything else as a document); the message becomes the caption.');
}

async function broadCast(): Promise<void> {
    const { message: rawMessage, filePath, targetUserIds } = parseArgs(process.argv.slice(2));

    // Let a single-line arg use literal \n for line breaks, so the whole message
    // can sit inside one set of quotes and the shell can never split it.
    const message = rawMessage.replace(/\\n/g, '\n');

    if (!rawMessage && !filePath) {
        usage();
        process.exit(1);
    }

    if (filePath && !fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
    }

    const payload: Payload = { text: message, filePath };

    try {
        await ensureConnection();

        let users: BroadcastUser[];

        if (targetUserIds) {
            const telegramIds = targetUserIds.split(',').map((id) => id.trim());
            const userIds = telegramIds.map((id) => `tg-${id}`);

            users = (await User.find({ userId: { $in: userIds } }, 'userId name').lean()) as unknown as BroadcastUser[];
            console.log(`Broadcasting to ${users.length} specific users...`);

            const foundUserIds = users.map((u) => u.userId.replace('tg-', ''));
            const notFoundIds = telegramIds.filter((id) => !foundUserIds.includes(id));
            if (notFoundIds.length > 0) {
                console.log(`Users not found in DB: ${notFoundIds.join(', ')}`);
            }
        } else {
            users = (await User.find({}, 'userId name').lean()) as unknown as BroadcastUser[];
            console.log(`Broadcasting to all ${users.length} users...`);
        }

        let successCount = 0;
        const failed: SendResult[] = [];

        for (let i = 0; i < users.length; i += BATCH_SIZE) {
            const batch = users.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(users.length / BATCH_SIZE);

            console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} users)...`);

            const results = await Promise.allSettled(batch.map((user) => sendWithRetry(user, payload)));

            for (const result of results) {
                const val: SendResult =
                    result.status === 'fulfilled'
                        ? result.value
                        : { success: false, error: (result.reason as Error)?.message };
                if (val.success) {
                    successCount++;
                    console.log(`  ✓ ${val.user?.name} (${val.telegramId})`);
                } else {
                    failed.push(val);
                    const label = val.permanent ? 'permanent' : 'transient';
                    console.error(`  ✗ ${val.user?.name} (${val.telegramId}) [${label}]: ${val.error}`);
                }
            }

            if (i + BATCH_SIZE < users.length) {
                await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
            }
        }

        console.log(`\nResults: ${successCount} sent, ${failed.length} failed`);

        if (failed.length > 0) {
            const failedIds = failed
                .filter((f) => f.telegramId)
                .map((f) => f.telegramId)
                .join(',');

            const logPath = path.resolve(__dirname, '../assets/broadcast-failed.txt');
            fs.writeFileSync(logPath, failedIds);
            console.log(`\nFailed IDs saved to assets/broadcast-failed.txt`);
            console.log(`Re-run failures with:`);
            console.log(`  tsx utils/broadcast.ts '${rawMessage}'${filePath ? ` --file ${filePath}` : ''} --to "${failedIds}"`);
        }
    } catch (error) {
        console.error('Broadcast error:', error);
    }

    process.exit(0);
}

broadCast();
