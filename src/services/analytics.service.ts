import axios from 'axios';
import { Telegraf } from 'telegraf';
import { User } from '../../models/user.js';
import { ensureConnection } from '../../db/connection.js';
import { config } from '../config/index.js';
import { findRecentSuccessful } from '../repositories/transaction.repository.js';
import type { AnalyticsData } from '../types/index.js';

const bot = new Telegraf(config.botToken);
const META_API_BASE = 'https://graph.facebook.com/v21.0';

async function sendWaText(phoneNumber: string, text: string): Promise<void> {
    await axios.post(
        `${META_API_BASE}/${config.metaPhoneNumberId}/messages`,
        {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'text',
            text: { body: text },
        },
        {
            headers: {
                Authorization: `Bearer ${config.metaAccessToken}`,
                'Content-Type': 'application/json',
            },
        }
    );
}

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

    let tgMessage = `*Florence\\* Analytics \\(${label}\\)*\n\n`;
    tgMessage += `*Users*\n`;
    tgMessage += `• Florence\\* has ${totalUsers} users now `;
    tgMessage += newUsers > 0
        ? `\\(\\+${newUsers} new users ${label}\\)\n`
        : `\\(no new users ${label}\\)\n`;

    tgMessage += `\n*Revenue*\n`;
    if (totalRevenue > 0) {
        tgMessage += `• Total revenue: ₦${totalRevenue.toLocaleString()} from ${uniqueCustomers} customer${uniqueCustomers !== 1 ? 's' : ''}\n`;
        tgMessage += `• Average revenue per paying customer: ₦${averageRevenuePerCustomer.toLocaleString()}\n`;
        tgMessage += `• Total transactions: ${transactions.length}\n`;
    } else {
        tgMessage += `• No revenue ${label}\n`;
    }

    if (topSpendersWithNames.length > 0) {
        tgMessage += `\n*Top Spenders*\n`;
        topSpendersWithNames.forEach((spender, index) => {
            tgMessage += `${index + 1}\\. ${spender.name} \\- ₦${spender.amount.toLocaleString()} \\(${spender.transactions} transaction${spender.transactions !== 1 ? 's' : ''}\\)\n`;
        });
    }

    let waMessage = `Florence Analytics (${label})\n\n`;
    waMessage += `Users\n`;
    waMessage += `• Florence* has ${totalUsers} users now `;
    waMessage += newUsers > 0
        ? `(+${newUsers} new users ${label})\n`
        : `(no new users ${label})\n`;

    waMessage += `\nRevenue\n`;
    if (totalRevenue > 0) {
        waMessage += `• Total revenue: ₦${totalRevenue.toLocaleString()} from ${uniqueCustomers} customer${uniqueCustomers !== 1 ? 's' : ''}\n`;
        waMessage += `• Average revenue per paying customer: ₦${averageRevenuePerCustomer.toLocaleString()}\n`;
        waMessage += `• Total transactions: ${transactions.length}\n`;
    } else {
        waMessage += `• No revenue ${label}\n`;
    }

    if (topSpendersWithNames.length > 0) {
        waMessage += `\nTop Spenders\n`;
        topSpendersWithNames.forEach((spender, index) => {
            waMessage += `${index + 1}. ${spender.name} - ₦${spender.amount.toLocaleString()} (${spender.transactions} transaction${spender.transactions !== 1 ? 's' : ''})\n`;
        });
    }

    for (const chatId of config.adminTelegramIds) {
        await bot.telegram.sendMessage(chatId, tgMessage, { parse_mode: 'MarkdownV2' });
    }

    for (const phoneNumber of config.adminWhatsappIds) {
        await sendWaText(phoneNumber, waMessage);
    }

    return { totalUsers, newUsers, totalRevenue, uniqueCustomers };
}
