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
        default: 10,
        required: true
    },
    streak: {
        type: Number,
        default: 0,
    },
    convoHistory: {
        type: Array,
        default: [
            {
                role: String,
                content: String | Array,
            }
        ],
    },
    convos: {
        type: Array,
        default: [
            {
                title: String,
                messages: [
                    {
                        role: String,
                        content: String | Array,
                    },
                ]
            }
        ],

    },
    lastTokenReward: {
        type: Date,
        default: Date.now
    },
    lastActiveDate: {
        type: Date,
        default: null
    },
    lastStreakUpdate: {
        type: Date,
        default: null
    },
    lastStreakReminder: {
        type: Date,
        default: null
    },
    lastStreakReward: {
        type: Date,
        default: null
    },
});

export const User = mongoose.model('User', userSchema);