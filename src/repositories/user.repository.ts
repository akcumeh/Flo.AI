import { User } from '../../models/user.js';
import { ensureConnection } from '../../db/connection.js';
import { plain, plainOrNull, plainList } from './mongo.util.js';
import type { IUser, CreateUserDto } from '../types/index.js';

export async function findUser(userId: string): Promise<IUser | null> {
    await ensureConnection();
    return plainOrNull<IUser>(await User.findOne({ userId }).lean());
}

export async function createUser(data: CreateUserDto): Promise<IUser> {
    await ensureConnection();
    const created = await User.create({
        userId: data.id,
        name: data.name,
        tokens: data.tokens ?? 10,
        email: data.email,
        streak: 0,
        convoHistory: [],
        convos: [],
        lastTokenReward: new Date(),
    });
    return plain<IUser>(created.toObject());
}

export async function updateUser(userId: string, updates: Partial<IUser>): Promise<IUser | null> {
    await ensureConnection();
    return plainOrNull<IUser>(
        await User.findOneAndUpdate({ userId }, { $set: updates }, { new: true }).lean()
    );
}

export async function incrementTokens(userId: string, amount: number): Promise<IUser | null> {
    await ensureConnection();
    return plainOrNull<IUser>(
        await User.findOneAndUpdate({ userId }, { $inc: { tokens: amount } }, { new: true }).lean()
    );
}

export async function countUsers(): Promise<number> {
    await ensureConnection();
    return await User.countDocuments({});
}

export async function countUsersCreatedSince(since: Date): Promise<number> {
    await ensureConnection();
    return await User.countDocuments({ createdAt: { $gte: since } });
}

export async function findUserName(userId: string): Promise<string | null> {
    await ensureConnection();
    const user = await User.findOne({ userId }, 'name').lean();
    return user ? (user as { name: string }).name : null;
}

export async function setStreak(userId: string, streak: number, lastActiveDate: Date): Promise<void> {
    await ensureConnection();
    await User.updateOne({ userId }, { $set: { streak, lastActiveDate } });
}

export async function grantStreakReward(userId: string, tokens: number, when: Date): Promise<void> {
    await ensureConnection();
    await User.updateOne({ userId }, { $inc: { tokens }, $set: { lastStreakReward: when } });
}

export async function findUsersForReminder(): Promise<IUser[]> {
    await ensureConnection();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return plainList<IUser>(
        await User.find({
            lastActiveDate: { $lt: yesterday },
            lastStreakReminder: { $lt: yesterday },
        }).lean()
    );
}

export async function resetInactiveStreaks(): Promise<number> {
    await ensureConnection();
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const result = await User.updateMany(
        { lastActiveDate: { $lt: twoDaysAgo }, streak: { $gt: 0 } },
        { $set: { streak: 0 } }
    );
    return result.modifiedCount;
}

export async function findUsersNeedingStreakReminder(todayStart: Date): Promise<IUser[]> {
    await ensureConnection();
    return plainList<IUser>(
        await User.find({
            streak: { $gt: 0 },
            $or: [{ lastActiveDate: { $exists: false } }, { lastActiveDate: { $lt: todayStart } }],
            $and: [
                {
                    $or: [
                        { lastStreakReminder: { $exists: false } },
                        { lastStreakReminder: { $lt: todayStart } },
                    ],
                },
            ],
        })
            .select('userId name streak lastStreakReminder')
            .lean()
    );
}

export async function markStreakReminderSent(userId: string, when: Date): Promise<void> {
    await ensureConnection();
    await User.updateOne({ userId }, { $set: { lastStreakReminder: when } });
}

export async function resetStreaksInactiveSince(since: Date): Promise<number> {
    await ensureConnection();
    const result = await User.updateMany(
        {
            streak: { $gt: 0 },
            $or: [{ lastActiveDate: { $exists: false } }, { lastActiveDate: { $lt: since } }],
        },
        { $set: { streak: 0 } }
    );
    return result.modifiedCount;
}

export async function findUsersForBroadcast(targetUserIds?: string[]): Promise<IUser[]> {
    await ensureConnection();
    if (targetUserIds && targetUserIds.length > 0) {
        const ids = targetUserIds.map((id) => `tg-${id}`);
        return plainList<IUser>(await User.find({ userId: { $in: ids } }, 'userId name').lean());
    }
    return plainList<IUser>(await User.find({}, 'userId name').lean());
}
