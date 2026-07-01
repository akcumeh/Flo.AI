import { Transaction } from '../../models/transactions.js';
import { ensureConnection } from '../../db/connection.js';
import type { ITransaction } from '../types/index.js';

export interface CreateTransactionDto {
    userId: string;
    reference: string;
    amount: number;
    tokens: number;
    email?: string;
    metadata?: object;
}

export async function createTransaction(data: CreateTransactionDto): Promise<ITransaction> {
    await ensureConnection();
    return await Transaction.create(data) as unknown as ITransaction;
}

export async function findByReference(reference: string): Promise<ITransaction | null> {
    await ensureConnection();
    return await Transaction.findOne({ reference }) as unknown as ITransaction | null;
}

export async function findUserTransactions(userId: string): Promise<ITransaction[]> {
    await ensureConnection();
    return await Transaction.find({ userId }).sort({ createdAt: -1 }) as unknown as ITransaction[];
}

export async function markSuccess(reference: string, gatewayResponse: object): Promise<ITransaction> {
    await ensureConnection();
    const tx = await Transaction.findOneAndUpdate(
        { reference },
        { $set: { status: 'success', completedAt: new Date(), gatewayResponse } },
        { new: true }
    );
    if (!tx) throw new Error(`Transaction not found: ${reference}`);
    return tx as unknown as ITransaction;
}

export async function claimSuccess(reference: string, gatewayResponse: object): Promise<ITransaction | null> {
    await ensureConnection();
    return await Transaction.findOneAndUpdate(
        { reference, status: { $ne: 'success' } },
        { $set: { status: 'success', completedAt: new Date(), gatewayResponse } },
        { new: true }
    ) as unknown as ITransaction | null;
}

export async function findRecentSuccessful(since: Date): Promise<ITransaction[]> {
    await ensureConnection();
    return await Transaction.find({
        status: 'success',
        completedAt: { $gte: since },
    }).lean() as unknown as ITransaction[];
}
