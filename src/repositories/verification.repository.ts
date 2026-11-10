import VerificationState from '../../models/verificationState.js';
import { ensureConnection } from '../../db/connection.js';

export async function hasVerified(userId: string, reference: string): Promise<boolean> {
    await ensureConnection();
    const found = await VerificationState.findOne({ userId, reference, status: 'verified' }).lean();
    return found !== null;
}

export async function recordVerification(userId: string, reference: string, tokens: number): Promise<void> {
    await ensureConnection();
    await VerificationState.create({
        userId,
        reference,
        status: 'verified',
        tokens,
        verifiedAt: new Date(),
    });
}

export async function recordVerificationIfMissing(
    userId: string,
    reference: string,
    tokens: number
): Promise<void> {
    await ensureConnection();
    await VerificationState.updateOne(
        { userId, reference },
        { $setOnInsert: { status: 'verified', tokens, verifiedAt: new Date() } },
        { upsert: true }
    );
}
