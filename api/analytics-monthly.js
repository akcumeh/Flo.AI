import { User } from '../models/user.js';
import { Transaction } from '../models/transactions.js';
import { ensureConnection } from '../db/connection.js';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

async function sendMonthlyAnalytics() {
    try {
        await ensureConnection();

        const now = new Date();
        const startDate = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

        const totalUsers = await User.countDocuments({});
        const newUsers = await User.countDocuments({
            lastTokenReward: { $gte: startDate }
        });

        const transactions = await Transaction.find({
            status: 'success',
            completedAt: { $gte: startDate }
        }).lean();

        const totalRevenue = transactions.reduce((sum, tx) => sum + tx.amount, 0);
        const uniqueCustomers = new Set(transactions.map(tx => tx.userId)).size;
        const averageRevenuePerCustomer = uniqueCustomers > 0 ? Math.round(totalRevenue / uniqueCustomers) : 0;

        const spenderMap = {};
        for (const tx of transactions) {
            if (!spenderMap[tx.userId]) {
                spenderMap[tx.userId] = { amount: 0, transactions: 0 };
            }
            spenderMap[tx.userId].amount += tx.amount;
            spenderMap[tx.userId].transactions += 1;
        }

        const topSpenders = Object.entries(spenderMap)
            .sort(([, a], [, b]) => b.amount - a.amount)
            .slice(0, 5);

        const topSpendersWithNames = [];
        for (const [userId, data] of topSpenders) {
            const user = await User.findOne({ userId }, 'name').lean();
            topSpendersWithNames.push({
                name: user ? user.name : 'Unknown',
                amount: data.amount,
                transactions: data.transactions
            });
        }

        let message = `📊 *Florence\\* Analytics \\(this month\\)*\n\n`;
        message += `👥 *Users*\n`;
        message += `• Florence\\* has ${totalUsers} users now `;
        if (newUsers > 0) {
            message += `\\(\\+${newUsers} new users this month\\)\n`;
        } else {
            message += `\\(no new users this month\\)\n`;
        }

        message += `\n💰 *Revenue*\n`;
        if (totalRevenue > 0) {
            message += `• Total revenue: ₦${totalRevenue.toLocaleString()} from ${uniqueCustomers} customer${uniqueCustomers !== 1 ? 's' : ''}\n`;
            message += `• Average revenue per paying customer: ₦${averageRevenuePerCustomer.toLocaleString()}\n`;
            message += `• Total transactions: ${transactions.length}\n`;
        } else {
            message += `• No revenue this month\n`;
        }

        if (topSpendersWithNames.length > 0) {
            message += `\n🏆 *Top Spenders This Month*\n`;
            topSpendersWithNames.forEach((spender, index) => {
                message += `${index + 1}\\. ${spender.name} \\- ₦${spender.amount.toLocaleString()} \\(${spender.transactions} transaction${spender.transactions !== 1 ? 's' : ''}\\)\n`;
            });
        }

        await bot.telegram.sendMessage(process.env.ADMIN_TG_ID, message, {
            parse_mode: 'MarkdownV2'
        });

        return { totalUsers, newUsers, totalRevenue, uniqueCustomers };

    } catch (error) {
        console.error('Monthly analytics error:', error);
        throw error;
    }
}

export default async function handler(req, res) {
    try {
        const analytics = await sendMonthlyAnalytics();

        res.status(200).json({
            success: true,
            message: 'Monthly analytics sent',
            data: analytics
        });

    } catch (error) {
        console.error('Monthly analytics API error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}