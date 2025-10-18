import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { Transaction } from '../models/transactions.js';

dotenv.config();

const FW_SECRET_KEY = process.env.FW_SECRET_KEY;
const FW_BASE_URL = 'https://api.flutterwave.com/v3';

function getNumericUserId(userId) {
    const matches = userId.match(/[^:,-]+$/);
    const extracted = matches ? matches[0] : userId;
    return extracted.replace(/[^0-9]/g, '');
}

export async function initFw(user, amount, callbackUrl) {
    try {
        const numericUserId = getNumericUserId(user.userId);
        const reference = `FLO-PAY-${Date.now()}-${numericUserId}`;

        const payload = {
            tx_ref: reference,
            amount: amount,
            currency: "NGN",
            redirect_url: callbackUrl,
            customer: {
                email: user.email || `${numericUserId}@placeholder.com`,
                name: user.name || 'User'
            },
            customizations: {
                title: "Florence Token Purchase",
                description: `${Math.floor(amount / 100)} tokens`
            }
        };

        const response = await fetch(`${FW_BASE_URL}/payments`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${FW_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (data.status === 'success') {
            await Transaction.create({
                userId: user.userId,
                reference,
                amount,
                tokens: Math.floor(amount / 100),
                email: user.email,
                status: 'pending',
                metadata: {
                    paymentLink: data.data.link,
                    provider: 'flutterwave'
                }
            });

            return {
                success: true,
                paymentLink: data.data.link,
                reference
            };
        } else {
            return {
                success: false,
                message: data.message || 'Payment initialization failed'
            };
        }
    } catch (error) {
        console.error('Flutterwave initialization error:', error);
        return {
            success: false,
            message: 'An error occurred while initializing payment'
        };
    }
}

export async function verifyFw(reference) {
    try {
        const transaction = await Transaction.findOne({ reference });

        if (!transaction) {
            return {
                success: false,
                message: 'Transaction not found'
            };
        }

        if (transaction.status === 'success') {
            return {
                success: true,
                message: 'Payment verified successfully',
                amount: transaction.amount,
                tokens: transaction.tokens,
                userId: transaction.userId
            };
        }

        const response = await fetch(
            `${FW_BASE_URL}/transactions/verify_by_reference?tx_ref=${reference}`,
            {
                headers: {
                    'Authorization': `Bearer ${FW_SECRET_KEY}`
                }
            }
        );

        const data = await response.json();

        if (data.status === 'success' && data.data.status === 'successful') {
            transaction.status = 'success';
            transaction.completedAt = new Date();
            await transaction.save();

            return {
                success: true,
                message: 'Payment verified successfully',
                amount: data.data.amount,
                tokens: transaction.tokens,
                userId: transaction.userId
            };
        } else {
            return {
                success: false,
                message: 'Payment not yet received'
            };
        }
    } catch (error) {
        console.error('Flutterwave verification error:', error);
        return {
            success: false,
            message: 'Verification failed'
        };
    }
}
