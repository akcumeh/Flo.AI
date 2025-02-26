import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true
    },
    email: {
        type: String,
    },
    tokens: {
        type: Number,
        default: 13,
        required: true
    },
    streak: {
        type: Number,
        default: 0
    },
    convoHistory: [
        {
        role: String,
        content: String
        },
    ],
    lastTokenReward: {
        type: Date,
        default: Date.now
    },
});

export const User = mongoose.model('User', userSchema);