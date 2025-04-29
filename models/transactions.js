// models/transactions.js

import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    reference: {
        type: String,
        required: true,
        unique: true
    },
    amount: {
        type: Number,
        required: true
    },
    tokens: {
        type: Number,
        required: true
    },
    email: {
        type: String
    },
    method: {
        type: String,
        enum: ['card', 'bank_transfer'],
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'success', 'failed'],
        default: 'pending'
    },
    gatewayResponse: {
        type: Object
    },
    metadata: {
        type: Object
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    completedAt: {
        type: Date
    }
});

export const Transaction = mongoose.model('Transaction', transactionSchema);