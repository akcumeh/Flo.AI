import express from 'express';
import dotenv from 'dotenv';
import { ensureConnection } from './db/connection.js';
import { tg } from './api/tg.js';
import { wa } from './api/wa.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3560;
const MONGODB_URI = process.env.MONGODB_URI;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mount API routes
app.use('/wa', wa);
app.use('/tg', tg.router);

// Add a simple home route
app.get('/', (req, res) => {
    res.send('Florence AI Bot - Server Running');
});

// Set Telegram Bot Webhook
const WEBHOOK_URL = process.env.WEBHOOK_URL;
if (WEBHOOK_URL) {
    tg.setupWebhook(WEBHOOK_URL);
} else {
    console.warn('WEBHOOK_URL not defined in environment variables. Webhook setup skipped.');
}

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send('Something went wrong');
});

// Connect to MongoDB and Start Server
ensureConnection()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('Failed to connect to MongoDB:', err);
        process.exit(1);
    });