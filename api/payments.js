import express from 'express';
import mongoose from 'mongoose';
import User from '../models/user.js';
import Payments from '../models/payments.js';

const paymentsRouter = express.Router();

paymentsRouter.post('/initiate', async (req, res) => {
    try {
        const { userId, amount } = req.body;

        // Verify user exists
        const user = await User.findOne({ userId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Create payment record
        const payment = await Payments.create({
            userId: user.userId,
            name: user.name,
            tokens: amount * 10,
            time: new Date(),
            payId: `${"FLO" + (new Date()).getTime() + "-" + user.userId}`,
            userEmail: user.email,
        });

        // Return payment details
        res.status(201).json({
            paymentId: payment.payId,
            amount,
            tokens: payment.tokens
        });

    } catch (error) {
        console.error('Payment initiation error:', error);
        res.status(500).json({ error: 'Failed to initiate payment' });
    }
});

paymentsRouter.post('/verify', async (req, res) => {
    try {
        const { paymentId, status } = req.body;

        const payment = await Payments.findOne({ payId: paymentId });
        if (!payment) {
            return res.status(404).json({ error: 'Payment not found' });
        }

        if (status === 'successful') {
            // Update user's tokens
            const user = await User.findOneAndUpdate(
                { userId: payment.userId },
                { $inc: { tokens: payment.tokens } },
                { new: true }
            );

            return res.json({
                success: true,
                newTokenBalance: user.tokens
            });
        }

        res.status(400).json({ error: 'Payment verification failed' });

    } catch (error) {
        console.error('Payment verification error:', error);
        res.status(500).json({ error: 'Failed to verify payment' });
    }
});

export default paymentsRouter;