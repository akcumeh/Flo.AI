import mongoose from 'mongoose';
import type { IRequestState } from '../src/types/index.js';

const schema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    tokenCost: { type: Number, default: 1 },
    messageId: { type: mongoose.Schema.Types.Mixed },
    status: {
        type: String,
        enum: ['processing', 'completed', 'cancelled', 'failed'],
        default: 'processing',
    },
    prompt: String,
    isMedia: { type: Boolean, default: false },
    mediaType: { type: String, enum: ['photo', 'document', null], default: null },
    mediaFileId: String,
    mediaMimeType: String,
    mediaFileName: String,
    error: String,
    thinkingMessageId: Number,
    chatId: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now, expires: 86400 },
});

export const RequestState = (
    mongoose.models['RequestState'] ?? mongoose.model('RequestState', schema)
) as mongoose.Model<IRequestState>;
