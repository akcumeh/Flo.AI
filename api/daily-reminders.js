import { ensureConnection } from '../db/connection.js';
import { User } from '../models/user.js';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

export default async function handler(req, res) {
    try {
        await ensureConnection();

        const today = new Date();
        const todayStart = new Date(today.setHours(0, 0, 0, 0));

        // Find users who need reminders in one efficient query
        const users = await User.find({
            streak: { $gt: 0 },
            // Haven't been active today
            $or: [
                { lastActiveDate: { $exists: false } },
                { lastActiveDate: { $lt: todayStart } }
            ],
            // Haven't received reminder today
            $and: [
                {
                    $or: [
                        { lastStreakReminder: { $exists: false } },
                        { lastStreakReminder: { $lt: todayStart } }
                    ]
                }
            ]
        }).select('userId name streak lastStreakReminder');

        let remindersSent = 0;
        const updatePromises = [];

        for (const user of users) {
            const telegramId = user.userId.replace('tg-', '');
            const firstName = user.name.split(' ')[0];
            const streakText = user.streak === 1 ? 'day' : 'days';

            const message = `Hi ${firstName}, have you used Florence* today? You're on a roll, keep your learning streak on fire!\n\n(Your current streak is ${user.streak} ${streakText})`;

            try {
                await bot.telegram.sendMessage(telegramId, message);

                // Queue the database update instead of doing it immediately
                updatePromises.push(
                    User.updateOne(
                        { _id: user._id },
                        { $set: { lastStreakReminder: today } }
                    )
                );

                remindersSent++;

            } catch (telegramError) {
                console.error(`Failed to send reminder to user ${user.userId}:`, telegramError.message);
            }
        }

        // Batch update all reminder timestamps
        if (updatePromises.length > 0) {
            await Promise.all(updatePromises);
        }

        res.status(200).json({
            status: 'success',
            message: `Sent ${remindersSent} streak reminders`,
            timestamp: new Date().toISOString(),
            eligibleUsers: users.length,
            remindersSent
        });

    } catch (error) {
        console.error('Error sending streak reminders:', error);
        res.status(500).json({
            status: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
}