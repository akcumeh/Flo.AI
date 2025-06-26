import { User } from '../models/user.js';
import { connectDB } from '../db/db.js';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

/**
 * Check if two dates are on the same day
 */
function isSameDay(date1, date2) {
    return date1.toDateString() === date2.toDateString();
}

/**
 * Check if date is yesterday relative to today
 */
function isYesterday(date, today = new Date()) {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return isSameDay(date, yesterday);
}

/**
 * Update user's streak based on their activity
 * Call this whenever a user sends a prompt
 */
export async function updateUserStreak(userId) {
    try {
        await connectDB(process.env.MONGODB_URI);

        const user = await User.findOne({ userId });
        if (!user) return null;

        const now = new Date();
        const lastActive = user.lastActiveDate ? new Date(user.lastActiveDate) : null;

        // If user hasn't been active before, start streak
        if (!lastActive) {
            user.streak = 1;
            user.lastActiveDate = now;
            user.lastStreakUpdate = now;
            await user.save();
            return { user, isNewStreak: true, streakIncreased: true };
        }

        // If already active today, no change needed
        if (isSameDay(lastActive, now)) {
            return { user, isNewStreak: false, streakIncreased: false };
        }

        // If active yesterday, increment streak
        if (isYesterday(lastActive, now)) {
            user.streak += 1;
            user.lastActiveDate = now;
            user.lastStreakUpdate = now;
            await user.save();
            return { user, isNewStreak: false, streakIncreased: true };
        }

        // If more than 1 day gap, reset streak
        user.streak = 1;
        user.lastActiveDate = now;
        user.lastStreakUpdate = now;
        await user.save();
        return { user, isNewStreak: true, streakIncreased: true };

    } catch (error) {
        console.error('Error updating user streak:', error);
        return null;
    }
}

/**
 * Check if user deserves streak reward (every 7 days)
 * Call this after answering their first prompt of the day
 */
export async function checkStreakReward(userId) {
    try {
        await connectDB(process.env.MONGODB_URI);

        const user = await User.findOne({ userId });
        if (!user) return false;

        // Check if streak is multiple of 7 and user hasn't been rewarded today
        if (user.streak > 0 && user.streak % 7 === 0) {
            const now = new Date();
            const lastReward = user.lastStreakReward ? new Date(user.lastStreakReward) : null;

            // Only reward once per streak milestone
            if (!lastReward || !isSameDay(lastReward, now)) {
                // Add 10 tokens
                user.tokens += 10;
                user.lastStreakReward = now;
                await user.save();

                // Send reward message
                const telegramId = userId.replace('tg-', '');
                const message = `Hi ${user.name.split(' ')[0]}, we're glad Florence* has helped you learn something new this week. Here are 10 tokens* to support your continued improvement 🩵`;

                try {
                    await bot.telegram.sendMessage(telegramId, message);
                } catch (telegramError) {
                    console.error('Error sending streak reward message:', telegramError);
                }

                return true;
            }
        }
        return false;
    } catch (error) {
        console.error('Error checking streak reward:', error);
        return false;
    }
}

/**
 * Send reminder to users who haven't been active today
 * Call this function at 22:00 daily via cron job
 */
export async function sendStreakReminders() {
    try {
        await connectDB(process.env.MONGODB_URI);

        const today = new Date();

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
                continue; // Already sent reminder today
            }

            // Send reminder
            const telegramId = user.userId.replace('tg-', '');
            const message = `Hi ${user.name.split(' ')[0]}, have you used Florence* today? You're on a roll, keep your learning streak on fire!\n\n(Your current streak is ${user.streak} days)`;

            try {
                await bot.telegram.sendMessage(telegramId, message);

                // Update reminder timestamp
                user.lastStreakReminder = today;
                await user.save();

                console.log(`Sent streak reminder to user ${user.userId}`);
            } catch (telegramError) {
                console.error(`Error sending reminder to user ${user.userId}:`, telegramError);
            }
        }

        console.log(`Processed streak reminders for ${users.length} users`);
    } catch (error) {
        console.error('Error sending streak reminders:', error);
    }
}

/**
 * Reset streaks for users who didn't send prompts yesterday
 * Call this function at 00:01 daily via cron job
 */
export async function resetInactiveStreaks() {
    try {
        await connectDB(process.env.MONGODB_URI);

        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        // Find users who have a streak but weren't active yesterday
        const users = await User.find({
            streak: { $gt: 0 },
            $or: [
                { lastActiveDate: { $exists: false } },
                { lastActiveDate: { $lt: new Date(yesterday.setHours(0, 0, 0, 0)) } }
            ]
        });

        let resetCount = 0;
        for (const user of users) {
            user.streak = 0;
            await user.save();
            resetCount++;
        }

        console.log(`Reset streaks for ${resetCount} inactive users`);
    } catch (error) {
        console.error('Error resetting inactive streaks:', error);
    }
}

/**
 * Get user's current streak info
 */
export async function getUserStreakInfo(userId) {
    try {
        await connectDB(process.env.MONGODB_URI);

        const user = await User.findOne({ userId });
        if (!user) return null;

        return {
            streak: user.streak || 0,
            lastActive: user.lastActiveDate,
            name: user.name
        };
    } catch (error) {
        console.error('Error getting user streak info:', error);
        return null;
    }
}