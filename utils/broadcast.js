import { User } from '../models/user.js';
import { ensureConnection } from '../db/connection.js';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

async function broadCast() {
    const message = process.argv[2];
    const targetUserIds = process.argv[3];

    if (!message) {
        console.log('Usage: node scripts/broadcast.js "Your message here" [comma-separated telegram IDs]');
        console.log('Examples:');
        console.log('  node scripts/broadcast.js "Hello everyone" (sends to all users)');
        console.log('  node scripts/broadcast.js "Hello specific users" "123456789,987654321"');
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
                console.log(`Users not found: ${notFoundIds.join(', ')}`);
            }
        } else {
            users = await User.find({}, 'userId name').lean();
            console.log(`Broadcasting to all ${users.length} users...`);
        }

        let successCount = 0;
        let errorCount = 0;

        for (const user of users) {
            try {
                const telegramId = user.userId.replace('tg-', '');
                await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'MarkdownV2' });
                successCount++;
                console.log(`Sent to ${user.name} (${telegramId})`);

                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (error) {
                errorCount++;
                console.error(`Failed to send to ${user.name}: ${error.message}`);
            }
        }

        console.log(`\nResults: ${successCount} sent, ${errorCount} failed`);

    } catch (error) {
        console.error('Broadcast error:', error);
    }

    process.exit(0);
}

broadCast();