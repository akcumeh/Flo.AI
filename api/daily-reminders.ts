import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendStreakReminders } from '../src/services/notification.service.js';

export default async function handler(_req: VercelRequest, res: VercelResponse): Promise<void> {
    try {
        const { eligibleUsers, remindersSent } = await sendStreakReminders();
        res.status(200).json({
            status: 'success',
            message: `Sent ${remindersSent} streak reminders`,
            timestamp: new Date().toISOString(),
            eligibleUsers,
            remindersSent,
        });
    } catch (error) {
        console.error('Error sending streak reminders:', error);
        res.status(500).json({
            status: 'error',
            message: (error as Error).message,
            timestamp: new Date().toISOString(),
        });
    }
}
