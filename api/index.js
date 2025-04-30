import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import { connectDB } from '../db/db.js';

dotenv.config();

// Connect to database
connectDB(process.env.MONGODB_URI);

// Initialize bot for webhook setup only
const bot = new Telegraf(process.env.BOT_TOKEN);

// Main entry point for Vercel
export default async function handler(req, res) {
    try {
        // Handle GET requests (e.g., health checks)
        if (req.method === 'GET') {
            return res.status(200).json({
                status: 'ok',
                message: 'Florence AI Bot API is running',
                version: '1.0.0'
            });
        }

        // Set webhook for Telegram if requested
        if (req.method === 'POST' && req.query.setup === 'webhook') {
            // Only allow this from authorized source
            const authToken = req.headers.authorization?.split(' ')[1];
            if (authToken !== process.env.ADMIN_API_KEY) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const webhookUrl = `${process.env.WEBHOOK_URL}/api/telegram/webhook`;
            await bot.telegram.setWebhook(webhookUrl);

            return res.status(200).json({
                success: true,
                message: `Webhook set to ${webhookUrl}`
            });
        }

        // Handle other requests
        return res.status(405).json({ error: 'Method not allowed' });
    } catch (error) {
        console.error('API error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}