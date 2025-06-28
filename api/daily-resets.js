import { connectDB } from '../db/db.js';
import { User } from '../models/user.js';
import dotenv from 'dotenv';

dotenv.config();

export default async function handler(req, res) {
    try {
        await connectDB(process.env.MONGODB_URI);

        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        // Find users who have a streak but weren't active yesterday
        const users = await User.find({
            streak: { $gt: 0 },
            $or: [
                { lastActiveDate: { $exists: false } },
                { lastActiveDate: { $lt: new Date(yesterday.setHours(0, 0, 0, 0)) } }
            ]
        });

        let resetCount = 0;
        for (const user of users) {
            const oldStreak = user.streak;
            user.streak = 0;
            await user.save();
            resetCount++;

            console.log(`Reset streak for user ${user.userId} from ${oldStreak} to 0`);
        }

        res.status(200).json({
            status: 'success',
            message: `Reset streaks for ${resetCount} inactive users`,
            timestamp: new Date().toISOString(),
            totalUsersChecked: users.length,
            streaksReset: resetCount
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