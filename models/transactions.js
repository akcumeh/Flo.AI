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
        unique: true,
        index: true
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
    expiresAt: {
        type: Date,
        default: function () {
            return new Date(Date.now() + 3600000); // 1 hour from creation
        }
    },
    completedAt: {
        type: Date
    }
});

// Add index for efficient queries
transactionSchema.index({ status: 1 });
transactionSchema.index({ expiresAt: 1 });

// Method to check if transaction has expired
transactionSchema.methods.hasExpired = function () {
    return new Date() > this.expiresAt;
};

export const Transaction = mongoose.model('Transaction', transactionSchema);