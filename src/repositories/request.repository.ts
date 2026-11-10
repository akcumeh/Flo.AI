import mongoose from 'mongoose';
import { RequestState } from '../../models/requestState.js';
import { ensureConnection } from '../../db/connection.js';
import { plain, plainOrNull, plainList } from './mongo.util.js';
import type { IRequestState } from '../types/index.js';

export type RequestStatus = IRequestState['status'];

export interface CreateRequestDto {
    id: string;
    userId: string;
    tokenCost: number;
    messageId?: string | number;
    prompt?: string;
    isMedia?: boolean;
    mediaType?: 'photo' | 'document';
    mediaFileId?: string;
    mediaMimeType?: string;
    mediaFileName?: string;
    thinkingMessageId?: number;
    chatId?: string | number;
}

export function newRequestId(): string {
    return new mongoose.Types.ObjectId().toString();
}

export async function createRequest(data: CreateRequestDto): Promise<IRequestState> {
    await ensureConnection();
    const { id, ...rest } = data;
    const created = await RequestState.create({ ...rest, _id: id, status: 'processing', createdAt: new Date() });
    return plain<IRequestState>(created.toObject());
}

export async function findRequestByMessage(
    messageId: string | number,
    userId?: string
): Promise<IRequestState | null> {
    await ensureConnection();
    const filter = userId === undefined ? { messageId } : { userId, messageId };
    return plainOrNull<IRequestState>(await RequestState.findOne(filter).lean());
}

export async function getRequest(id: string): Promise<IRequestState | null> {
    await ensureConnection();
    return plainOrNull<IRequestState>(await RequestState.findById(id).lean());
}

export async function claimRequest(
    id: string,
    to: Exclude<RequestStatus, 'processing'>,
    error?: string
): Promise<IRequestState | null> {
    await ensureConnection();
    const set: Record<string, unknown> = { status: to };
    if (error !== undefined) set['error'] = error;
    return plainOrNull<IRequestState>(
        await RequestState.findOneAndUpdate({ _id: id, status: 'processing' }, { $set: set }).lean()
    );
}

export async function cancelRequest(id: string, userId: string): Promise<IRequestState | null> {
    await ensureConnection();
    return plainOrNull<IRequestState>(
        await RequestState.findOneAndUpdate(
            { _id: id, userId, status: 'processing' },
            { $set: { status: 'cancelled' } }
        ).lean()
    );
}

export async function setRequestStatus(id: string, status: RequestStatus): Promise<void> {
    await ensureConnection();
    await RequestState.updateOne({ _id: id }, { $set: { status } });
}

export async function findStaleProcessing(userId: string, olderThan: Date): Promise<IRequestState[]> {
    await ensureConnection();
    return plainList<IRequestState>(
        await RequestState.find({ userId, status: 'processing', createdAt: { $lt: olderThan } }).lean()
    );
}
