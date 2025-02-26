import mongoose from "mongoose";

const paymentsSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        unique: true,
    },
    name: {
        type: String,
        required: true,
    },
    email: {
        type: String,
    },
    tokens: {
        type: Number,
        default: 10,
        required: true,
    },
    time: {
        type: Date,
        default: Date.now,
        required: true,
    },
    payId: {
        type: String || Number,
        required: true,
        unique: true,
    },
    paymentMethod: {
        type: String,
        required: true,
    }
    // what else?
});

export const Payments = mongoose.model('Payments', paymentsSchema);