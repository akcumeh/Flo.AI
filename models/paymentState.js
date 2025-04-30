// models/paymentState.js
import mongoose from 'mongoose';

const paymentStateSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    step: {
        type: String,
        enum: ['init', 'email', 'save_card', 'processing', 'completed', 'cancelled'],
        default: 'init'
    },
    method: {
        type: String,
        enum: ['card', 'bank', null],
        default: null
    },
    amount: {
        type: Number,
        default: 1000
    },
    tokens: {
        type: Number,
        default: 25
    },
    email: {
        type: String
    },
    saveCard: {
        type: Boolean,
        default: false
    },
    reference: {
        type: String
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 3600 // Auto-delete after 1 hour
    }
});

export const PaymentState = mongoose.model('PaymentState', paymentStateSchema);