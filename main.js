import express from 'express';
import dotenv from 'dotenv';
import connectDB from './db/db.js';
import { wa } from './api/wa.js';
import { tg } from './api/tg.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/wa', wa);
app.use('/tg', tg.router);

// Set Telegram Bot Webhook
const WEBHOOK_URL = process.env.WEBHOOK_URL;
if (WEBHOOK_URL) {
    tg.bot.telegram.setWebhook(`${WEBHOOK_URL}/api/tg`)
        .then(() => console.log('TG Bot webhook set to', `${WEBHOOK_URL}/api/tg`))
        .catch(error => console.error('Error setting TG Bot webhook', error));
}

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send('Something went wrong');
});

// Connect to MongoDB and Start Server
connectDB(MONGO_URI).then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
});