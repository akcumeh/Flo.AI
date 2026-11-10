import { Session } from '../../models/session.js';
import { ensureConnection } from '../../db/connection.js';
import { plain, plainOrNull } from './mongo.util.js';
import type { ISession } from '../types/index.js';

export interface CreateSessionDto {
    userId: string;
    platform: ISession['platform'];
    mode: ISession['mode'];
    expiresAt: Date;
}

export async function findSessionByUser(userId: string): Promise<ISession | null> {
    await ensureConnection();
    return plainOrNull<ISession>(await Session.findOne({ userId }).lean());
}

export async function createSession(data: CreateSessionDto): Promise<ISession> {
    await ensureConnection();
    const created = await Session.create({ ...data, status: 'collecting' });
    return plain<ISession>(created.toObject());
}

export async function deleteSessionsForUser(userId: string): Promise<void> {
    await ensureConnection();
    await Session.deleteMany({ userId });
}

export async function deleteSession(id: string): Promise<void> {
    await ensureConnection();
    await Session.deleteOne({ _id: id });
}

export async function saveSession(session: ISession): Promise<void> {
    await ensureConnection();
    await Session.updateOne(
        { _id: session.id },
        {
            $set: {
                status: session.status,
                fileIds: session.fileIds,
                requestedCount: session.requestedCount,
                generatedCount: session.generatedCount,
                questions: session.questions,
                currentIndex: session.currentIndex,
                answers: session.answers,
                score: session.score,
                charged: session.charged,
                filesReleased: session.filesReleased,
                expiresAt: session.expiresAt,
            },
        }
    );
}
