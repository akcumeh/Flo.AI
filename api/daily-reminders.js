import { connectDB } from '../db/db.js';
import { User } from '../models/user.js';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

function isSameDay(date1, date2) {
    return date1.toDateString() === date2.toDateString();
}

export default async function handler(req, res) {
    try {
        await connectDB(process.env.MONGODB_URI);

        const today = new Date();
        let remindersSent = 0;

        // Find users who:
        // 1. Have a streak > 0
        // 2. Haven't been active today
        // 3. Haven't received a reminder today
        const users = await User.find({
            streak: { $gt: 0 },
            $or: [
                { lastActiveDate: { $exists: false } },
                { lastActiveDate: { $not: { $gte: new Date(today.setHours(0, 0, 0, 0)) } } }
            ]
        });

        for (const user of users) {
            // Check if reminder already sent today
            const lastReminder = user.lastStreakReminder ? new Date(user.lastStreakReminder) : null;
            if (lastReminder && isSameDay(lastReminder, today)) {
                continue; // Skip if already sent today
            }

            // Send reminder
            const telegramId = user.userId.replace('tg-', '');
            const firstName = user.name.split(' ')[0];
            const message = `Hi ${firstName}, have you used Florence* today? You're on a roll, keep your learning streak on fire!\n\n(Your current streak is ${user.streak} days)`;

            try {
                await bot.telegram.sendMessage(telegramId, message);

                // Update reminder timestamp
                user.lastStreakReminder = today;
                await user.save();

                remindersSent++;
                console.log(`Sent streak reminder to user ${user.userId}`);
            } catch (telegramError) {
                console.error(`Error sending reminder to user ${user.userId}:`, telegramError);
            }
        }

        res.status(200).json({
            status: 'success',
            message: `Sent ${remindersSent} streak reminders`,
            timestamp: new Date().toISOString(),
            totalUsersChecked: users.length,
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