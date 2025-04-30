// models/requestState.js
import mongoose from 'mongoose';

const requestStateSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    tokenCost: {
        type: Number,
        default: 1
    },
    messageId: {
        type: Number
    },
    status: {
        type: String,
        enum: ['processing', 'completed', 'cancelled', 'failed'],
        default: 'processing'
    },
    prompt: {
        type: String
    },
    error: {
        type: String
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 86400 // Auto-delete after 24 hours
    }
});

export const RequestState = mongoose.model('RequestState', requestStateSchema);