import mongoose from 'mongoose';
import type { IMediaGroup } from '../src/types/index.js';

const schema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    mediaGroupId: { type: String, required: true },
    status: {
        type: String,
        enum: ['collecting', 'processing', 'completed', 'cancelled', 'failed'],
        default: 'collecting',
    },
    caption: { type: String, default: '' },
    mediaItems: [
        {
            fileId: String,
            type: { type: String, enum: ['photo', 'document'] },
            mimeType: String,
        },
    ],
    tokenCost: { type: Number, default: 2 },
    result: String,
    error: String,
    expiresAt: Date,
    lastActivity: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now, expires: 86400 },
});

export const MediaGroup = (
    mongoose.models['MediaGroup'] ?? mongoose.model('MediaGroup', schema)
) as mongoose.Model<IMediaGroup>;
