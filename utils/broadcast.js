import { User } from '../models/user.js';
import { ensureConnection } from '../db/connection.js';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

async function broadCast() {
    const message = process.argv[2];

    if (!message) {
        console.log('Usage: node scripts/broadcast.js "Your message here"');
        process.exit(1);
    }

    try {
        await ensureConnection();

        const users = await User.find({}, 'userId name').lean();
        console.log(`Broadcasting to ${users.length} users...`);

        let successCount = 0;
        let errorCount = 0;

        for (const user of users) {
            try {
                const telegramId = user.userId.replace('tg-', '');
                await bot.telegram.sendMessage(telegramId, message);
                successCount++;
                console.log(`✅ Sent to ${user.name}`);

                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (error) {
                errorCount++;
                console.error(`❌ Failed to send to ${user.name}: ${error.message}`);
            }
        }

        console.log(`\n📊 Results: ${successCount} sent, ${errorCount} failed`);

    } catch (error) {
        console.error('Broadcast error:', error);
    }

    process.exit(0);
}

broadCast();