import mongoose from 'mongoose';

const verificationStateSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: ['awaiting_reference', 'processing'],
        default: 'awaiting_reference'
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 600 // Auto-delete after 10 minutes
    }
});

const VerificationState = mongoose.models.VerificationState ||
    mongoose.model('VerificationState', verificationStateSchema);

export default VerificationState;