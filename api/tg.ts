import type { VercelRequest, VercelResponse } from '@vercel/node';
import { bot } from '../src/controllers/telegram.controller.js';
import { config } from '../src/config/index.js';
import { ensureConnection } from '../db/connection.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    try {
        if (req.method === 'GET') {
            if (req.query.setwebhook === 'true') {
                const webhookUrl = `${config.webhookUrl}/api/tg`;
                await bot.telegram.setWebhook(webhookUrl);
                res.status(200).json({ success: true, message: `Webhook set to ${webhookUrl}` });
                return;
            }
            res.status(200).send('Telegram webhook is active');
            return;
        }

        if (req.method !== 'POST') {
            res.status(405).send('Method not allowed');
            return;
        }

        await ensureConnection();
        await bot.handleUpdate(req.body as Parameters<typeof bot.handleUpdate>[0]);
        res.status(200).send('OK');
    } catch (error) {
        console.error('Error handling Telegram webhook:', error);
        res.status(200).send('Error processed');
    }
}
