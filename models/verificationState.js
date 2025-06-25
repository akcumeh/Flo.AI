import mongoose from 'mongoose';

const verificationStateSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    reference: {
        type: String,
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: ['verified', 'failed'],
        default: 'verified'
    },
    tokens: {
        type: Number,
        required: true
    },
    verifiedAt: {
        type: Date,
        default: Date.now
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

verificationStateSchema.index({ userId: 1, reference: 1 }, { unique: true });

const VerificationState = mongoose.models.VerificationState ||
    mongoose.model('VerificationState', verificationStateSchema);

export default VerificationState;