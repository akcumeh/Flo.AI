import { User } from '../../models/user.js';
import { ensureConnection } from '../../db/connection.js';
import type { IUser, CreateUserDto } from '../types/index.js';

export async function findUser(userId: string): Promise<IUser | null> {
    await ensureConnection();
    return await User.findOne({ userId }) as unknown as IUser | null;
}

export async function createUser(data: CreateUserDto): Promise<IUser> {
    await ensureConnection();
    return await User.create({
        userId: data.id,
        name: data.name,
        tokens: data.tokens ?? 10,
        email: data.email,
        streak: 0,
        convoHistory: [],
        convos: [],
        lastTokenReward: new Date(),
    }) as unknown as IUser;
}

export async function updateUser(userId: string, updates: Partial<IUser>): Promise<IUser | null> {
    await ensureConnection();
    return await User.findOneAndUpdate(
        { userId },
        { $set: updates },
        { new: true }
    ) as unknown as IUser | null;
}

export async function countUsers(filter: Record<string, unknown> = {}): Promise<number> {
    await ensureConnection();
    return await User.countDocuments(filter);
}

export async function findUsersForReminder(): Promise<IUser[]> {
    await ensureConnection();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return await User.find({
        lastActiveDate: { $lt: yesterday },
        lastStreakReminder: { $lt: yesterday },
    }) as unknown as IUser[];
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

// Users with an active streak who haven't used the bot today and haven't already
// been reminded today. Mirrors the original api/daily-reminders.js query.
export async function findUsersNeedingStreakReminder(todayStart: Date): Promise<IUser[]> {
    await ensureConnection();
    return await User.find({
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
    }).select('userId name streak lastStreakReminder') as unknown as IUser[];
}

export async function markStreakReminderSent(userId: string, when: Date): Promise<void> {
    await ensureConnection();
    await User.updateOne({ userId }, { $set: { lastStreakReminder: when } });
}

// Zero out streaks for users inactive since `since`. Mirrors api/daily-resets.js.
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
        return await User.find({ userId: { $in: ids } }, 'userId name').lean() as unknown as IUser[];
    }
    return await User.find({}, 'userId name').lean() as unknown as IUser[];
}
