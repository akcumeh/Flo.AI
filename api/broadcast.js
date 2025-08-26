import { User } from '../models/user.js';
import { ensureConnection } from '../db/connection.js';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const authToken = req.headers.authorization?.split(' ')[1];
    if (authToken !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await ensureConnection();

        const { message, targetUserIds } = req.body;

        if (!message) {
            return res.status(400).json({
                error: 'Message is required',
                usage: 'POST with { "message": "Your message", "targetUserIds": ["id1","id2"] }'
            });
        }

        let users;

        if (targetUserIds && targetUserIds.length > 0) {
            const userIds = targetUserIds.map(id => `tg-${id}`);
            users = await User.find({ userId: { $in: userIds } }, 'userId name').lean();
        } else {
            users = await User.find({}, 'userId name').lean();
        }

        let successCount = 0;
        let errorCount = 0;
        const errors = [];

        for (const user of users) {
            try {
                const telegramId = user.userId.replace('tg-', '');
                await bot.telegram.sendMessage(telegramId, message);
                successCount++;

                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (error) {
                errorCount++;
                errors.push({
                    user: user.name,
                    telegramId: user.userId.replace('tg-', ''),
                    error: error.message
                });
            }
        }

        return res.status(200).json({
            success: true,
            totalUsers: users.length,
            successCount,
            errorCount,
            errors: errors.slice(0, 5)
        });

    } catch (error) {
        console.error('Broadcast error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}