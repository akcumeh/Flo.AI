import { ensureConnection } from '../db/connection.js';
import { User } from '../models/user.js';
import dotenv from 'dotenv';

dotenv.config();

export default async function handler(req, res) {
    try {
        await ensureConnection();

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);

        // Direct bulk update - much more efficient
        const result = await User.updateMany(
            {
                streak: { $gt: 0 },
                $or: [
                    { lastActiveDate: { $exists: false } },
                    { lastActiveDate: { $lt: yesterday } }
                ]
            },
            { $set: { streak: 0 } }
        );

        res.status(200).json({
            status: 'success',
            message: `Reset streaks for ${result.modifiedCount} inactive users`,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error resetting inactive streaks:', error);
        res.status(500).json({
            status: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
}