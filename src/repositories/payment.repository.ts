import { PaymentState } from '../../models/paymentState.js';
import { ensureConnection } from '../../db/connection.js';
import { plain, plainOrNull } from './mongo.util.js';
import type { IPaymentState } from '../types/index.js';

export interface PaymentStatePatch {
    step?: IPaymentState['step'];
    method?: IPaymentState['method'];
    amount?: number;
    tokens?: number;
    email?: string | null;
    saveCard?: boolean;
    reference?: string;
    createdAt?: Date;
}

export async function upsertPaymentState(userId: string, patch: PaymentStatePatch): Promise<IPaymentState> {
    await ensureConnection();
    const doc = await PaymentState.findOneAndUpdate({ userId }, patch, { upsert: true, new: true }).lean();
    return plain<IPaymentState>(doc);
}

export async function getPaymentState(userId: string): Promise<IPaymentState | null> {
    await ensureConnection();
    return plainOrNull<IPaymentState>(await PaymentState.findOne({ userId }).lean());
}

export async function savePaymentState(state: IPaymentState): Promise<void> {
    await ensureConnection();
    const fields: Record<string, unknown> = {
        step: state.step,
        method: state.method,
        amount: state.amount,
        tokens: state.tokens,
        email: state.email,
        saveCard: state.saveCard,
        reference: state.reference,
    };
    for (const key of Object.keys(fields)) {
        if (fields[key] === undefined) delete fields[key];
    }
    await PaymentState.updateOne({ _id: state.id }, { $set: fields });
}

export async function deletePaymentState(userId: string): Promise<void> {
    await ensureConnection();
    await PaymentState.deleteOne({ userId });
}
