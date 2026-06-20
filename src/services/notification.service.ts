import { Telegraf } from 'telegraf';
import { config } from '../config/index.js';
import * as userRepo from '../repositories/user.repository.js';

// Lightweight bot instance used only for outbound sends from cron/admin jobs.
const bot = new Telegraf(config.botToken);

export interface ReminderResult {
    eligibleUsers: number;
    remindersSent: number;
}

export async function sendStreakReminders(): Promise<ReminderResult> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const users = await userRepo.findUsersNeedingStreakReminder(todayStart);
    const now = new Date();
    let remindersSent = 0;

    for (const user of users) {
        const telegramId = user.userId.replace('tg-', '');
        const firstName = user.name.split(' ')[0];
        const streakText = user.streak === 1 ? 'day' : 'days';
        const message = `Hi ${firstName}, have you used Florence* today? You're on a roll, keep your learning streak on fire!\n\n(Your current streak is ${user.streak} ${streakText})`;

        try {
            await bot.telegram.sendMessage(telegramId, message);
            await userRepo.markStreakReminderSent(user.userId, now);
            remindersSent++;
        } catch (error) {
            console.error(`Failed to send reminder to user ${user.userId}:`, (error as Error).message);
        }
    }

    return { eligibleUsers: users.length, remindersSent };
}

export async function resetInactiveStreaks(): Promise<number> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    return await userRepo.resetStreaksInactiveSince(yesterday);
}

export interface BroadcastResult {
    totalUsers: number;
    successCount: number;
    errorCount: number;
    errors: Array<{ user: string; telegramId: string; error: string }>;
}

export async function broadcast(message: string, targetUserIds?: string[]): Promise<BroadcastResult> {
    const users = await userRepo.findUsersForBroadcast(targetUserIds);
    let successCount = 0;
    let errorCount = 0;
    const errors: BroadcastResult['errors'] = [];

    for (const user of users) {
        const telegramId = user.userId.replace('tg-', '');
        try {
            await bot.telegram.sendMessage(telegramId, message);
            successCount++;
            await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
            errorCount++;
            errors.push({ user: user.name, telegramId, error: (error as Error).message });
        }
    }

    return { totalUsers: users.length, successCount, errorCount, errors: errors.slice(0, 5) };
}
