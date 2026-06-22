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

const ANIMATION_FILE = path.resolve(__dirname, '../assets/bundles-launch.mp4');

const CAPTION = `Late-night STEM grinds shouldn't be interrupted by constant token top-ups. We noticed our power users hitting a wall right when they needed to focus the most.

Today, we are rolling out Florence Bundles*. Instead of topping up multiple times a week, you can now secure your token balance upfront, save money, and maintain your momentum without breaking your study flow.`;

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

async function sendToUser(telegramId, useAnimation, message) {
    if (useAnimation) {
        await bot.telegram.sendAnimation(
            telegramId,
            { source: fs.createReadStream(ANIMATION_FILE) },
            { caption: CAPTION }
        );
    } else {
        await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'MarkdownV2' });
    }
}

async function sendWithRetry(user, useAnimation, message) {
    const telegramId = user.userId.replace('tg-', '');

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await sendToUser(telegramId, useAnimation, message);
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
    const message = process.argv[2];
    const targetUserIds = process.argv[3];

    const useAnimation = !message && fs.existsSync(ANIMATION_FILE);

    if (!message && !useAnimation) {
        console.log('Usage: node utils/broadcast.js "Your message here" [comma-separated telegram IDs]');
        console.log('Examples:');
        console.log('  node utils/broadcast.js "Hello everyone"');
        console.log('  node utils/broadcast.js "Hello specific users" "123456789,987654321"');
        console.log('  node utils/broadcast.js  (no args — sends ANIMATION_FILE + CAPTION to all users)');
        process.exit(1);
    }

    try {
        await ensureConnection();

        let users;

        if (targetUserIds) {
            const telegramIds = targetUserIds.split(',').map(id => id.trim());
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
                batch.map(user => sendWithRetry(user, useAnimation, message))
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
