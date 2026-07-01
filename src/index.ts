// Local development entrypoint. On Vercel the functions in `api/*.ts` are the
// real entrypoints; this file only exists so `npm run dev` can run the bot
// locally via long polling plus an Express server for the WhatsApp webhook.
import express from 'express';
import { config } from './config/index.js';
import { bot } from './controllers/telegram.controller.js';
import { handler as whatsappHandler } from './controllers/whatsapp.controller.js';
import ensureConnection from '../db/connection.js';

async function main(): Promise<void> {
    await ensureConnection();

    const app = express();
    app.use(express.json());

    // WhatsApp webhook (Meta) — same handler the Vercel function uses.
    app.all(/^\/api\/wa/, (req, res) => whatsappHandler(req as never, res as never));
    app.get('/health', (_req, res) => res.status(200).send('ok'));

    app.listen(Number(config.port), () => {
        console.log(`Local server listening on http://localhost:${config.port}`);
    });

    // Telegram via long polling locally (no public webhook needed in dev).
    await bot.launch();
    console.log('Telegram bot started (long polling)');

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((err) => {
    console.error('Failed to start local server:', err);
    process.exit(1);
});
