import express from 'express';
import dotenv from 'dotenv';
import { wa } from './api/wa.js';
import { tg } from './api/tg.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/wa', wa);
app.use('/tg', tg.router);

const WEBHOOK_URL = process.env.WEBHOOK_URL;
if (WEBHOOK_URL) {
    try {
        await tg.bot.telegram.setWebhook(`${WEBHOOK_URL}/tg`);
        console.log('TG Bot webhook set to ', `${WEBHOOK_URL}/tg`);
    } catch (error) {
        console.error('Error setting TG Bot webhook', error);
    }
};

app.use((err, res) => {
    console.error(err);
    res.status(500).send('Something went wrong');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});