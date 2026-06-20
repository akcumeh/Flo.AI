import { User } from '../../models/user.js';
import { ensureConnection } from '../../db/connection.js';
import { config } from '../config/index.js';
import { Telegraf } from 'telegraf';
import type { IUser, StreakResult, StreakInfo } from '../types/index.js';

const bot = new Telegraf(config.botToken);

function isSameDay(a: Date, b: Date): boolean {
    return a.toDateString() === b.toDateString();
}

function isYesterday(date: Date, today = new Date()): boolean {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return isSameDay(date, yesterday);
}

export async function updateStreak(userId: string): Promise<StreakResult | null> {
    try {
        await ensureConnection();

        const user = await User.findOne({ userId }) as unknown as IUser & { save(): Promise<void> };
        if (!user) return null;

        const now = new Date();
        const lastActive = user.lastActiveDate ? new Date(user.lastActiveDate) : null;

        if (!lastActive) {
            user.streak = 1;
            user.lastActiveDate = now;
            await user.save();
            return { user, isNewStreak: true, streakIncreased: true };
        }

        if (isSameDay(lastActive, now)) {
            return { user, isNewStreak: false, streakIncreased: false };
        }

        if (isYesterday(lastActive, now)) {
            user.streak += 1;
            user.lastActiveDate = now;
            await user.save();
            return { user, isNewStreak: false, streakIncreased: true };
        }

        user.streak = 1;
        user.lastActiveDate = now;
        await user.save();
        return { user, isNewStreak: true, streakIncreased: true };
    } catch (error) {
        console.error('Error updating user streak:', error);
        return null;
    }
}

export async function checkStreakReward(userId: string): Promise<boolean> {
    try {
        await ensureConnection();

        const user = await User.findOne({ userId }) as unknown as IUser & { save(): Promise<void> };
        if (!user) return false;

        if (user.streak > 0 && user.streak % 7 === 0) {
            const now = new Date();
            const lastReward = user.lastStreakReward ? new Date(user.lastStreakReward) : null;

            if (!lastReward || !isSameDay(lastReward, now)) {
                user.tokens += 10;
                user.lastStreakReward = now;
                await user.save();

                const telegramId = userId.replace('tg-', '');
                const firstName = user.name.split(' ')[0];
                const message = `Hi ${firstName}, we're glad Florence* has helped you learn something new this week. Here are 10 tokens* to support your continued improvement`;

                try {
                    await bot.telegram.sendMessage(telegramId, message);
                } catch (err) {
                    console.error('Error sending streak reward message:', err);
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

export async function getStreakInfo(userId: string): Promise<StreakInfo | null> {
    try {
        await ensureConnection();

        const user = await User.findOne({ userId }) as unknown as IUser | null;
        if (!user) return null;

        return {
            streak: user.streak || 0,
            lastActive: user.lastActiveDate ?? null,
            name: user.name,
        };
    } catch (error) {
        console.error('Error getting user streak info:', error);
        return null;
    }
}
