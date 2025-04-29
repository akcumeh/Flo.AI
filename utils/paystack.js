// utils/paystack.js

import fetch from 'node-fetch';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { Transaction } from '../models/transactions.js';

dotenv.config();

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SK_TEST;
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

// Helper to make authenticated requests to Paystack API
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

function getNumericUserId(userId) {
    // Handle prefixes like 'tg:123456789' or 'tg-123456789'
    const matches = userId.match(/[^:,-]+$/);
    return matches ? matches[0] : userId;
}

// Initialize a card payment transaction
export async function initializeCardPayment(user, amount) {
    try {
        // Extract numeric user ID for reference
        const numericUserId = getNumericUserId(user.userId);
        const reference = `FLO-CARD-${Date.now()}-${numericUserId}`;

        const payload = {
            email: user.email || `${numericUserId}@placeholder.com`,
            amount: amount * 100, // Paystack amount is in kobo (100 kobo = 1 Naira)
            reference,
            callback_url: `${process.env.WEBHOOK_URL}/`,
            metadata: {
                user_id: user.userId, // Keep full ID in metadata
                payment_type: 'token_purchase',
                tokens: Math.floor(amount / 40), // 1000 Naira = 25 tokens
                save_card: user.saveCard || false
            }
        };

        const response = await paystackRequest('/transaction/initialize', 'POST', payload);

        if (response.status) {
            // Create a transaction record
            await Transaction.create({
                userId: user.userId, // Store full user ID in database
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

// Initialize a bank transfer payment
export async function initializeBankTransfer(user, amount) {
    try {
        // Extract numeric user ID for reference
        const numericUserId = getNumericUserId(user.userId);
        const reference = `FLO-BANK-${Date.now()}-${numericUserId}`;

        // Create transaction record
        const transaction = await Transaction.create({
            userId: user.userId, // Store full user ID in database
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

        // Return bank details
        return {
            success: true,
            message: 'Please transfer the funds to the following account:',
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


// Verify a payment transaction
export async function verifyTransaction(reference) {
    try {
        // Make sure the reference doesn't have any special characters that could cause issues
        const cleanReference = reference.replace(/[^a-zA-Z0-9-]/g, '');

        console.log(`Verifying transaction with reference: ${cleanReference}`);

        // First check our database for the transaction
        const transaction = await Transaction.findOne({ reference: cleanReference });

        if (!transaction) {
            console.error('Transaction not found in database:', cleanReference);
            return {
                success: false,
                message: 'Transaction not found in our records'
            };
        }

        try {
            // Try to verify with Paystack
            const response = await paystackRequest(`/transaction/verify/${cleanReference}`);

            if (response.status && response.data.status === 'success') {
                // Update transaction status
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
                // For testing, we can bypass Paystack verification for bank transfers
                // This will be removed in production
                if (transaction.method === 'bank_transfer' && process.env.NODE_ENV === 'development') {
                    console.log('DEV MODE: Bypassing Paystack verification for bank transfer');

                    // Update transaction status
                    transaction.status = 'success';
                    transaction.completedAt = new Date();
                    await transaction.save();

                    return {
                        success: true,
                        message: 'Payment verified successfully (Development mode)',
                        amount: transaction.amount,
                        tokens: transaction.tokens,
                        userId: transaction.userId
                    };
                }

                return {
                    success: false,
                    message: response.message || 'Transaction verification failed with Paystack'
                };
            }
        } catch (error) {
            console.error('Error verifying with Paystack API:', error);

            // For testing, we can bypass Paystack API errors
            if (process.env.NODE_ENV === 'development') {
                console.log('DEV MODE: Bypassing Paystack API error');

                // Update transaction status
                transaction.status = 'success';
                transaction.completedAt = new Date();
                await transaction.save();

                return {
                    success: true,
                    message: 'Payment verified successfully (Development mode)',
                    amount: transaction.amount,
                    tokens: transaction.tokens,
                    userId: transaction.userId
                };
            }

            return {
                success: false,
                message: 'An error occurred while contacting Paystack'
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


// Verify Paystack webhook signature
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