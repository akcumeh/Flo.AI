import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import { ensureConnection } from '../db/connection.js';

dotenv.config();

export default async function handler(req, res) {
    try {
        // Validate the admin token
        const authToken = req.headers.authorization?.split(' ')[1];
        if (authToken !== process.env.ADMIN_API_KEY) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Connect to database
        await ensureConnection();
        console.log('Connected to MongoDB');

        // Initialize Telegram bot
        const bot = new Telegraf(process.env.BOT_TOKEN);

        // Set webhook
        const webhookUrl = `${process.env.WEBHOOK_URL}/api/tg`;
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`Webhook set to ${webhookUrl}`);

        // Test the webhook
        const webhookInfo = await bot.telegram.getWebhookInfo();

        return res.status(200).json({
            success: true,
            message: 'Setup complete',
            webhook: webhookInfo
        });
    } catch (error) {
        console.error('Setup error:', error);
        return res.status(500).json({
            success: false,
            message: `Setup failed: ${error.message}`
        });
    }
}