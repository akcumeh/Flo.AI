import type { VercelRequest, VercelResponse } from '@vercel/node';
import { config } from '../src/config/index.js';
import { broadcast } from '../src/services/notification.service.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const authToken = req.headers.authorization?.split(' ')[1];
    if (authToken !== config.adminApiKey) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    try {
        const { message, targetUserIds } = (req.body ?? {}) as {
            message?: string;
            targetUserIds?: string[];
        };

        if (!message) {
            res.status(400).json({
                error: 'Message is required',
                usage: 'POST with { "message": "Your message", "targetUserIds": ["id1","id2"] }',
            });
            return;
        }

        const result = await broadcast(message, targetUserIds);
        res.status(200).json({ success: true, ...result });
    } catch (error) {
        console.error('Broadcast error:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
}
