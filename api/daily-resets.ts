import type { VercelRequest, VercelResponse } from '@vercel/node';
import { resetInactiveStreaks } from '../src/services/notification.service.js';

export default async function handler(_req: VercelRequest, res: VercelResponse): Promise<void> {
    try {
        const modifiedCount = await resetInactiveStreaks();
        res.status(200).json({
            status: 'success',
            message: `Reset streaks for ${modifiedCount} inactive users`,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Error resetting inactive streaks:', error);
        res.status(500).json({
            status: 'error',
            message: (error as Error).message,
            timestamp: new Date().toISOString(),
        });
    }
}
