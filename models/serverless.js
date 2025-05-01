import mongoose from 'mongoose';

// Request State model for tracking requests
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
    isMedia: {
        type: Boolean,
        default: false
    },
    mediaType: {
        type: String,
        enum: ['photo', 'document', null],
        default: null
    },
    mediaFileId: {
        type: String
    },
    mediaMimeType: {
        type: String
    },
    mediaFileName: {
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

// Payment State model for handling payment flow
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
        default: 10
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

// Media Group model for handling multiple images
const mediaGroupSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: ['collecting', 'processing', 'completed', 'cancelled', 'failed'],
        default: 'collecting'
    },
    caption: {
        type: String,
        default: ''
    },
    mediaItems: [{
        fileId: String,
        type: {
            type: String,
            enum: ['photo', 'document']
        }
    }],
    tokenCost: {
        type: Number,
        default: 2
    },
    result: {
        type: String
    },
    error: {
        type: String
    },
    expiresAt: {
        type: Date
    },
    lastActivity: {
        type: Date,
        default: Date.now
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 86400 // Auto-delete after 24 hours
    }
});

export const RequestState = mongoose.model('RequestState', requestStateSchema);
export const PaymentState = mongoose.model('PaymentState', paymentStateSchema);
export const MediaGroup = mongoose.model('MediaGroup', mediaGroupSchema);