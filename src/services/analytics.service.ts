import { Telegraf } from 'telegraf';
import { User } from '../../models/user.js';
import { ensureConnection } from '../../db/connection.js';
import { config } from '../config/index.js';
import { findRecentSuccessful } from '../repositories/transaction.repository.js';
import type { AnalyticsData } from '../types/index.js';

const bot = new Telegraf(config.botToken);

export async function sendAnalytics(period: 'week' | 'month'): Promise<AnalyticsData> {
    await ensureConnection();

    const now = new Date();
    const days = period === 'week' ? 7 : 30;
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const label = period === 'week' ? 'this week' : 'this month';
    const topCount = period === 'week' ? 3 : 5;

    const totalUsers = await User.countDocuments({});
    const newUsers = await User.countDocuments({ createdAt: { $gte: startDate } });
    const transactions = await findRecentSuccessful(startDate);

    const totalRevenue = transactions.reduce((sum, tx) => sum + tx.amount, 0);
    const uniqueCustomers = new Set(transactions.map((tx) => tx.userId)).size;
    const averageRevenuePerCustomer = uniqueCustomers > 0 ? Math.round(totalRevenue / uniqueCustomers) : 0;

    const spenderMap: Record<string, { amount: number; transactions: number }> = {};
    for (const tx of transactions) {
        if (!spenderMap[tx.userId]) {
            spenderMap[tx.userId] = { amount: 0, transactions: 0 };
        }
        spenderMap[tx.userId].amount += tx.amount;
        spenderMap[tx.userId].transactions += 1;
    }

    const topSpenders = Object.entries(spenderMap)
        .sort(([, a], [, b]) => b.amount - a.amount)
        .slice(0, topCount);

    const topSpendersWithNames = await Promise.all(
        topSpenders.map(async ([userId, data]) => {
            const user = await User.findOne({ userId }, 'name').lean();
            return { name: user ? (user as { name: string }).name : 'Unknown', ...data };
        })
    );

    let message = `*Florence\\* Analytics \\(${label}\\)*\n\n`;
    message += `*Users*\n`;
    message += `• Florence\\* has ${totalUsers} users now `;
    message += newUsers > 0
        ? `\\(\\+${newUsers} new users ${label}\\)\n`
        : `\\(no new users ${label}\\)\n`;

    message += `\n*Revenue*\n`;
    if (totalRevenue > 0) {
        message += `• Total revenue: ₦${totalRevenue.toLocaleString()} from ${uniqueCustomers} customer${uniqueCustomers !== 1 ? 's' : ''}\n`;
        message += `• Average revenue per paying customer: ₦${averageRevenuePerCustomer.toLocaleString()}\n`;
        message += `• Total transactions: ${transactions.length}\n`;
    } else {
        message += `• No revenue ${label}\n`;
    }

    if (topSpendersWithNames.length > 0) {
        message += `\n*Top Spenders*\n`;
        topSpendersWithNames.forEach((spender, index) => {
            message += `${index + 1}\\. ${spender.name} \\- ₦${spender.amount.toLocaleString()} \\(${spender.transactions} transaction${spender.transactions !== 1 ? 's' : ''}\\)\n`;
        });
    }

    for (const chatId of config.adminTelegramIds) {
        await bot.telegram.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
    }

    return { totalUsers, newUsers, totalRevenue, uniqueCustomers };
}
