// api/debug.js
import { Telegraf } from 'telegraf';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

export default async function handler(req, res) {
    // Only allow with admin key
    const authToken = req.headers.authorization?.split(' ')[1];
    if (authToken !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        // Check bot token
        const bot = new Telegraf(process.env.BOT_TOKEN);
        let botInfo = null;
        try {
            botInfo = await bot.telegram.getMe();
        } catch (botError) {
            botInfo = { error: botError.message };
        }

        // Check MongoDB connection
        let dbStatus = "Unknown";
        try {
            await mongoose.connect(process.env.MONGODB_URI);
            dbStatus = mongoose.connection.readyState === 1 ? "Connected" : "Disconnected";
        } catch (dbError) {
            dbStatus = `Error: ${dbError.message}`;
        }

        // Check webhook
        let webhookInfo = null;
        try {
            webhookInfo = await bot.telegram.getWebhookInfo();
        } catch (webhookError) {
            webhookInfo = { error: webhookError.message };
        }

        // Return all environment information
        return res.status(200).json({
            version: '1.0.0',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            bot: {
                info: botInfo,
                webhook: webhookInfo
            },
            database: {
                status: dbStatus,
                uri: process.env.MONGODB_URI ?
                    `${process.env.MONGODB_URI.split('@')[0].split('//')[0]}//***:***@${process.env.MONGODB_URI.split('@')[1]}`
                    : 'Not configured'
            },
            webhookUrl: process.env.WEBHOOK_URL || 'Not configured',
            envVars: {
                BOT_TOKEN: process.env.BOT_TOKEN ? '✓ Present' : '✗ Missing',
                MONGODB_URI: process.env.MONGODB_URI ? '✓ Present' : '✗ Missing',
                WEBHOOK_URL: process.env.WEBHOOK_URL ? '✓ Present' : '✗ Missing',
                CLAUDE_API_KEY: process.env.CLAUDE_API_KEY ? '✓ Present' : '✗ Missing',
                PAYSTACK_SK_TEST: process.env.PAYSTACK_SK_TEST ? '✓ Present' : '✗ Missing',
            }
        });
    } catch (error) {
        console.error('Debug error:', error);
        return res.status(500).json({
            success: false,
            message: `Debug failed: ${error.message}`
        });
    }
}