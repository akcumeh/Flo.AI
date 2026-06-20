import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendAnalytics } from '../src/services/analytics.service.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    try {
        const data = await sendAnalytics('week');
        res.status(200).json({ success: true, message: 'Weekly analytics sent', data });
    } catch (error) {
        console.error('Weekly analytics error:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
}
