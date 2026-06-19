import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { User } from '../models/user.js';
import { ensureConnection } from '../db/connection.js';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bot = new Telegraf(process.env.BOT_TOKEN);

const MEDIA_FILE = path.resolve(__dirname, '../assets/flo-reviews-ad.jpg');

const CAPTION = `Our students have been using Florence for a while now, and honestly, they love it.

Engineering students, law students, pharmacy, biochemistry, even mass comm and psychology. Different course loads, same result.

We are sharing this because we genuinely think it will help.

Give it a try when you get a chance, and let us know what you think.

You can learn more about us on <a href="https://www.linkedin.com/posts/myflorenceai_we-put-this-out-because-university-of-lagos-activity-7470387227227947008-FW-B?utm_source=share&utm_medium=member_desktop&rcm=ACoAADJvBLkBgrsD5Gg252PCsVMHMrLx6i7ClJU">LinkedIn</a> and follow us on X: https://x.com/useflorenceai/status/2064621796620395009`;

const TEST_TELEGRAM_ID = process.env.MY_TELEGRAM_ID || '';

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------
const BATCH_SIZE = 25;       // concurrent sends per batch (stay under Telegram's 30/sec limit)
const MAX_RETRIES = 3;       // retry attempts per user on transient errors
const RETRY_BASE_MS = 1000;  // first retry waits 1s, second 2s, third 4s (exponential)
const BATCH_PAUSE_MS = 1000; // pause between batches (gives Telegram a breath)
// ---------------------------------------------------------------------------

const TRANSIENT_ERRORS = ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'];

function isTransient(error) {
    return TRANSIENT_ERRORS.some(code => error.message?.includes(code) || error.code === code);
}

function getMediaType() {
    if (!MEDIA_FILE || !fs.existsSync(MEDIA_FILE)) return null;
    const ext = path.extname(MEDIA_FILE).toLowerCase();
    if (ext === '.mp4' || ext === '.gif') return 'animation';
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp') return 'photo';
    return null;
}

async function sendToUser(telegramId, mediaType, message) {
    if (mediaType === 'animation') {
        await bot.telegram.sendAnimation(
            telegramId,
            { source: fs.createReadStream(MEDIA_FILE) },
            { caption: CAPTION, parse_mode: 'HTML' }
        );
    } else if (mediaType === 'photo') {
        await bot.telegram.sendPhoto(
            telegramId,
            { source: fs.createReadStream(MEDIA_FILE) },
            { caption: CAPTION, parse_mode: 'HTML' }
        );
    } else {
        await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'MarkdownV2' });
    }
}

async function sendWithRetry(user, mediaType, message) {
    const telegramId = user.userId.replace('tg-', '');

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await sendToUser(telegramId, mediaType, message);
            return { success: true, user, telegramId };
        } catch (error) {
            const transient = isTransient(error);
            const lastAttempt = attempt === MAX_RETRIES;

            if (transient && !lastAttempt) {
                const waitMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
                console.warn(`  [retry ${attempt}/${MAX_RETRIES}] ${user.name} — ${error.message} — waiting ${waitMs}ms`);
                await new Promise(r => setTimeout(r, waitMs));
            } else {
                return { success: false, user, telegramId, error: error.message, permanent: !transient };
            }
        }
    }
}

async function broadCast() {
    const args = process.argv.slice(2);
    const testMode = args.includes('--test');
    const message = args.find(a => !a.startsWith('--') && a !== '') || null;
    const targetArg = args.find((a, i) => !a.startsWith('--') && i > 0 && args[i - 1] !== '--test') || null;

    const mediaType = getMediaType();
    const hasContent = message || mediaType;

    if (!hasContent) {
        console.log('Usage:');
        console.log('  node utils/broadcast.js                        — send MEDIA_FILE + CAPTION to all users');
        console.log('  node utils/broadcast.js --test                 — send to TEST_TELEGRAM_ID only');
        console.log('  node utils/broadcast.js "text message"         — send plain text to all users');
        console.log('  node utils/broadcast.js "" "123,456"           — send MEDIA_FILE + CAPTION to specific IDs');
        process.exit(1);
    }

    try {
        await ensureConnection();

        let users;

        if (testMode) {
            if (!TEST_TELEGRAM_ID) {
                console.error('Set MY_TELEGRAM_ID in .env or set TEST_TELEGRAM_ID at the top of broadcast.js');
                process.exit(1);
            }
            users = [{ userId: `tg-${TEST_TELEGRAM_ID}`, name: 'You (test)' }];
            console.log(`TEST MODE — sending only to ${TEST_TELEGRAM_ID}`);
        } else if (targetArg) {
            const telegramIds = targetArg.split(',').map(id => id.trim());
            const userIds = telegramIds.map(id => `tg-${id}`);
            users = await User.find({ userId: { $in: userIds } }, 'userId name').lean();
            console.log(`Broadcasting to ${users.length} specific users...`);

            const foundUserIds = users.map(u => u.userId.replace('tg-', ''));
            const notFoundIds = telegramIds.filter(id => !foundUserIds.includes(id));
            if (notFoundIds.length > 0) {
                console.log(`Users not found in DB: ${notFoundIds.join(', ')}`);
            }
        } else {
            users = await User.find({}, 'userId name').lean();
            console.log(`Broadcasting to all ${users.length} users...`);
        }

        let successCount = 0;
        const failed = [];

        for (let i = 0; i < users.length; i += BATCH_SIZE) {
            const batch = users.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(users.length / BATCH_SIZE);

            console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} users)...`);

            const results = await Promise.allSettled(
                batch.map(user => sendWithRetry(user, mediaType, message))
            );

            for (const result of results) {
                const val = result.status === 'fulfilled' ? result.value : { success: false, error: result.reason?.message };
                if (val?.success) {
                    successCount++;
                    console.log(`  ✓ ${val.user.name} (${val.telegramId})`);
                } else {
                    failed.push(val);
                    const label = val?.permanent ? 'permanent' : 'transient';
                    console.error(`  ✗ ${val?.user?.name} (${val?.telegramId}) [${label}]: ${val?.error}`);
                }
            }

            if (i + BATCH_SIZE < users.length) {
                await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
            }
        }

        console.log(`\nResults: ${successCount} sent, ${failed.length} failed`);

        if (failed.length > 0) {
            const failedIds = failed
                .filter(f => f?.telegramId)
                .map(f => f.telegramId)
                .join(',');

            const logPath = path.resolve(__dirname, '../assets/broadcast-failed.txt');
            fs.writeFileSync(logPath, failedIds);
            console.log(`\nFailed IDs saved to assets/broadcast-failed.txt`);
            console.log(`Re-run failures with:`);
            console.log(`  node utils/broadcast.js "" "${failedIds}"`);
        }

    } catch (error) {
        console.error('Broadcast error:', error);
    }

    process.exit(0);
}

broadCast();
