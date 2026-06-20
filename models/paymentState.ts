import mongoose from 'mongoose';
import type { IPaymentState } from '../src/types/index.js';

const schema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    step: {
        type: String,
        enum: ['init', 'bundle_select', 'email', 'save_card', 'processing', 'completed', 'cancelled'],
        default: 'init',
    },
    method: { type: String, enum: ['card', 'bank', null], default: null },
    amount: { type: Number, default: 1000 },
    tokens: { type: Number, default: 10 },
    email: String,
    saveCard: { type: Boolean, default: false },
    reference: String,
    createdAt: { type: Date, default: Date.now, expires: 3600 },
});

export const PaymentState = (
    mongoose.models['PaymentState'] ?? mongoose.model('PaymentState', schema)
) as mongoose.Model<IPaymentState>;
