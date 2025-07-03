import { User } from '../models/user.js';
import { ensureConnection } from '../db/connection.js';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

function isSameDay(date1, date2) {
    return date1.toDateString() === date2.toDateString();
}

function isYesterday(date, today = new Date()) {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return isSameDay(date, yesterday);
}

/**
 * Update user's streak when they send a prompt
 */
export async function updateUserStreak(userId) {
    try {
        await ensureConnection();

        const user = await User.findOne({ userId });
        if (!user) return null;

        const now = new Date();
        const lastActive = user.lastActiveDate ? new Date(user.lastActiveDate) : null;

        // If user hasn't been active before, start streak
        if (!lastActive) {
            user.streak = 1;
            user.lastActiveDate = now;
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
            await user.save();
            return { user, isNewStreak: false, streakIncreased: true };
        }

        // If more than 1 day gap, reset streak
        user.streak = 1;
        user.lastActiveDate = now;
        await user.save();
        return { user, isNewStreak: true, streakIncreased: true };

    } catch (error) {
        console.error('Error updating user streak:', error);
        return null;
    }
}

/**
 * Check if user deserves streak reward (every 7 days)
 */
export async function checkStreakReward(userId) {
    try {
        await ensureConnection();


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
                const firstName = user.name.split(' ')[0];
                const message = `Hi ${firstName}, we're glad Florence* has helped you learn something new this week. Here are 10 tokens* to support your continued improvement 🩵`;

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
 * Get user's current streak info
 */
export async function getUserStreakInfo(userId) {
    try {
        await ensureConnection();

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