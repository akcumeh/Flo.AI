import { Transaction } from '../../models/transactions.js';
import { ensureConnection } from '../../db/connection.js';
import { plain, plainOrNull, plainList } from './mongo.util.js';
import type { ITransaction } from '../types/index.js';

export interface CreateTransactionDto {
    userId: string;
    reference: string;
    amount: number;
    tokens: number;
    email?: string;
    metadata?: object;
}

export function hasExpired(tx: ITransaction): boolean {
    return new Date() > tx.expiresAt;
}

export async function createTransaction(data: CreateTransactionDto): Promise<ITransaction> {
    await ensureConnection();
    const created = await Transaction.create(data);
    return plain<ITransaction>(created.toObject());
}

export async function findByReference(reference: string): Promise<ITransaction | null> {
    await ensureConnection();
    return plainOrNull<ITransaction>(await Transaction.findOne({ reference }).lean());
}

export async function findUserTransactions(userId: string): Promise<ITransaction[]> {
    await ensureConnection();
    return plainList<ITransaction>(await Transaction.find({ userId }).sort({ createdAt: -1 }).lean());
}

export async function markFailed(reference: string): Promise<void> {
    await ensureConnection();
    await Transaction.updateOne({ reference }, { $set: { status: 'failed' } });
}

export async function markSuccess(reference: string, gatewayResponse: object): Promise<ITransaction> {
    await ensureConnection();
    const tx = await Transaction.findOneAndUpdate(
        { reference },
        { $set: { status: 'success', completedAt: new Date(), gatewayResponse } },
        { new: true }
    ).lean();
    if (!tx) throw new Error(`Transaction not found: ${reference}`);
    return plain<ITransaction>(tx);
}

export async function claimSuccess(reference: string, gatewayResponse: object): Promise<ITransaction | null> {
    await ensureConnection();
    return plainOrNull<ITransaction>(
        await Transaction.findOneAndUpdate(
            { reference, status: { $ne: 'success' } },
            { $set: { status: 'success', completedAt: new Date(), gatewayResponse } },
            { new: true }
        ).lean()
    );
}

export async function findRecentSuccessful(since: Date): Promise<ITransaction[]> {
    await ensureConnection();
    return plainList<ITransaction>(
        await Transaction.find({
            status: 'success',
            completedAt: { $gte: since },
        }).lean()
    );
}
