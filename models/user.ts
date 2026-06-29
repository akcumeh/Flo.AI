import mongoose from 'mongoose';
import type { IUser } from '../src/types/index.js';

const userSchema = new mongoose.Schema(
    {
        userId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        email: { type: String },
        tokens: { type: Number, default: 10, required: true },
        streak: { type: Number, default: 0 },
        convoHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
        convos: { type: [mongoose.Schema.Types.Mixed], default: [] },
        lastTokenReward: { type: Date, default: Date.now },
        lastActiveDate: { type: Date, default: null },
        lastStreakUpdate: { type: Date, default: null },
        lastStreakReminder: { type: Date, default: null },
        lastStreakReward: { type: Date, default: null },
    },
    { timestamps: true }
);

export const User = (
    mongoose.models['User'] ?? mongoose.model('User', userSchema)
) as mongoose.Model<IUser>;
