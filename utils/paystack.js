import fetch from 'node-fetch';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { Transaction } from '../models/transactions.js';

dotenv.config();

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SK_TEST;
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

/**
 * Makes authenticated requests to Paystack API
 */
async function paystackRequest(endpoint, method = 'GET', data = null) {
    try {
        const options = {
            method,
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
        };

        if (data && (method === 'POST' || method === 'PUT')) {
            options.body = JSON.stringify(data);
        }

        const response = await fetch(`${PAYSTACK_BASE_URL}${endpoint}`, options);
        return await response.json();
    } catch (error) {
        console.error('Paystack API request error:', error);
        throw error;
    }
}

/**
 * Extracts numeric user ID from prefixed IDs (e.g., 'tg:123456789')
 */
function getNumericUserId(userId) {
    const matches = userId.match(/[^:,-]+$/);
    return matches ? matches[0] : userId;
}

/**
 * Initializes a card payment transaction with Paystack
 */
export async function initializeCardPayment(user, amount, callbackUrl) {
    try {
        const numericUserId = getNumericUserId(user.userId);
        const reference = `FLO-CARD-${Date.now()}-${numericUserId}`;

        const payload = {
            email: user.email || `${numericUserId}@placeholder.com`,
            amount: amount * 100, // Paystack amount is in kobo (100 kobo = 1 Naira)
            reference,
            callback_url: callbackUrl,
            metadata: {
                user_id: user.userId,
                payment_type: 'token_purchase',
                tokens: Math.floor(amount / 40), // 1000 Naira = 25 tokens
                save_card: user.saveCard || false
            }
        };

        const response = await paystackRequest('/transaction/initialize', 'POST', payload);

        if (response.status) {
            await Transaction.create({
                userId: user.userId,
                reference,
                amount,
                tokens: Math.floor(amount / 40),
                email: user.email,
                method: 'card',
                status: 'pending',
                metadata: {
                    save_card: user.saveCard || false,
                    authorizationUrl: response.data.authorization_url
                }
            });

            return {
                success: true,
                message: 'Payment initialized',
                authorizationUrl: response.data.authorization_url,
                reference: response.data.reference
            };
        } else {
            return {
                success: false,
                message: `Payment initialization failed: ${response.message}`,
            };
        }
    } catch (error) {
        console.error('Card payment initialization error:', error);
        return {
            success: false,
            message: 'An error occurred while initializing payment',
        };
    }
}

/**
 * Initializes a bank transfer payment
 */
export async function initializeBankTransfer(user, amount, callbackUrl) {
    try {
        const numericUserId = getNumericUserId(user.userId);
        const reference = `FLO-BANK-${Date.now()}-${numericUserId}`;

        const transaction = await Transaction.create({
            userId: user.userId,
            reference,
            amount,
            tokens: Math.floor(amount / 40),
            email: user.email,
            method: 'bank_transfer',
            status: 'pending',
            metadata: {
                bankName: process.env.PAYSTACK_BANK_NAME,
                accountName: process.env.PAYSTACK_ACCOUNT_NAME,
                accountNumber: process.env.PAYSTACK_ACCOUNT_NUMBER
            }
        });

        return {
            success: true,
            message: 'Please transfer the funds to the following account:',
            reference,
            bankDetails: {
                accountName: process.env.PAYSTACK_ACCOUNT_NAME,
                accountNumber: process.env.PAYSTACK_ACCOUNT_NUMBER,
                bankName: process.env.PAYSTACK_BANK_NAME,
                amount: amount,
                reference: reference
            }
        };
    } catch (error) {
        console.error('Bank transfer initialization error:', error);
        return {
            success: false,
            message: 'An error occurred while initializing bank transfer'
        };
    }
}

/**
 * Verifies a payment transaction against Paystack's API
 */
export async function verifyTransaction(reference) {
    try {
        const cleanReference = reference.replace(/[^a-zA-Z0-9-]/g, '');
        console.log(`Verifying transaction with reference: ${cleanReference}`);

        const transaction = await Transaction.findOne({ reference: cleanReference });

        if (!transaction) {
            console.error('Transaction not found in database:', cleanReference);
            return {
                success: false,
                message: 'Transaction not found in our records'
            };
        }

        const response = await paystackRequest(`/transaction/verify/${cleanReference}`);

        if (response.status && response.data.status === 'success') {
            transaction.status = 'success';
            transaction.completedAt = new Date();
            transaction.gatewayResponse = response.data;
            await transaction.save();

            return {
                success: true,
                message: 'Payment verified successfully',
                amount: response.data.amount / 100, // Convert back to Naira
                tokens: transaction.tokens,
                userId: transaction.userId
            };
        } else {
            return {
                success: false,
                message: response.message || 'Transaction verification failed with Paystack'
            };
        }
    } catch (error) {
        console.error('Transaction verification error:', error);
        return {
            success: false,
            message: 'An error occurred while verifying transaction'
        };
    }
}

/**
 * Verifies Paystack webhook signature for security
 */
export function verifyWebhookSignature(requestBody, signature) {
    try {
        const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(requestBody))
            .digest('hex');

        return hash === signature;
    } catch (error) {
        console.error('Webhook signature verification error:', error);
        return false;
    }
}