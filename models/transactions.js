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
    paymentStatus: {
        type: String,
        enum: ['pending', 'success', 'failed'],
        default: 'pending'
    },
    verificationStatus: {
        type: String,
        enum: ['pending', 'verified'],
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
    verifiedAt: {
        type: Date
    },
    completedAt: {
        type: Date
    }
});

// Add index for efficient queries
transactionSchema.index({ paymentStatus: 1, verificationStatus: 1 });

// Method to check if transaction has expired
transactionSchema.methods.hasExpired = function () {
    return new Date() > this.expiresAt;
};

// Method to mark transaction as verified
transactionSchema.methods.markAsVerified = async function () {
    if (this.verificationStatus === 'verified') {
        return false; // Already verified
    }

    this.verificationStatus = 'verified';
    this.verifiedAt = new Date();
    await this.save();
    return true;
};

export const Transaction = mongoose.model('Transaction', transactionSchema);