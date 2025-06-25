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
        const reference = `FLO-PAY-${Date.now()}-${numericUserId}`;

        const payload = {
            email: user.email || `${numericUserId}@placeholder.com`,
            amount: amount * 100, // Paystack amount is in kobo (100 kobo = 1 Naira)
            reference,
            callback_url: callbackUrl,
            metadata: {
                user_id: user.userId,
                payment_type: 'token_purchase',
                tokens: Math.floor(amount / 100) // 1000 Naira = 25 tokens
            }
        };

        const response = await paystackRequest('/transaction/initialize', 'POST', payload);

        if (response.status) {
            await Transaction.create({
                userId: user.userId,
                reference,
                amount,
                tokens: Math.floor(amount / 100),
                email: user.email,
                method: 'card', // Keep this for database consistency
                status: 'pending',
                metadata: {
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
        console.error('Payment initialization error:', error);
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

        // Use environment variables or fall back to defaults
        const bankName = process.env.PAYSTACK_BANK_NAME || DEFAULT_BANK_NAME;
        const accountName = process.env.PAYSTACK_ACCOUNT_NAME || DEFAULT_ACCOUNT_NAME;
        const accountNumber = process.env.PAYSTACK_ACCOUNT_NUMBER || DEFAULT_ACCOUNT_NUMBER;

        console.log(`Bank Transfer - Reference: ${reference}, Bank: ${bankName}`);

        const transaction = await Transaction.create({
            userId: user.userId,
            reference,
            amount,
            tokens: Math.floor(amount / 100),
            email: user.email,
            method: 'bank_transfer',
            status: 'pending',
            metadata: {
                bankName,
                accountName,
                accountNumber
            }
        });

        return {
            success: true,
            message: 'Please transfer the funds to the following account:',
            reference,
            bankDetails: {
                accountName,
                accountNumber,
                bankName,
                amount,
                reference
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
        if (!reference) {
            console.error('No reference provided for verification');
            return {
                success: false,
                message: 'Please provide a valid reference number.'
            };
        }

        const cleanReference = reference.replace(/[^a-zA-Z0-9-]/g, '');
        console.log(`Verifying transaction with reference: ${cleanReference}`);

        const transaction = await Transaction.findOne({ reference: cleanReference });

        if (!transaction) {
            console.error('Transaction not found in database:', cleanReference);
            return {
                success: false,
                message: 'Transaction not found. Please check your reference number.'
            };
        }

        // Check if transaction has expired
        if (transaction.hasExpired() && transaction.status === 'pending') {
            transaction.status = 'failed';
            await transaction.save();
            return {
                success: false,
                message: 'This payment link has expired. Please initiate a new payment.'
            };
        }

        if (cleanReference.includes('FLO-BANK')) {
            return {
                success: false,
                message: 'Bank transfer payments require manual verification. We will confirm your payment within 24 hours.',
                isPending: true
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

        // Check if payment was marked as failed
        if (transaction.status === 'failed') {
            return {
                success: false,
                message: 'This payment was not completed. Please try making a new payment.'
            };
        }

        if (PAYSTACK_SECRET_KEY) {
            try {
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
                        amount: response.data.amount / 100,
                        tokens: transaction.tokens,
                        userId: transaction.userId
                    };
                } else {
                    // Payment not successful on Paystack
                    return {
                        success: false,
                        message: 'Payment not yet received. If you just made the payment, please wait a few minutes and try again.'
                    };
                }
            } catch (apiError) {
                console.error('Paystack API error:', apiError);
                return {
                    success: false,
                    message: 'Unable to verify payment at this time. Please try again in a few minutes.'
                };
            }
        } else {
            // Test mode without Paystack API
            console.warn('Paystack API key not configured, using test mode');
            return {
                success: false,
                message: 'Payment verification is in test mode. Please contact support.'
            };
        }
    } catch (error) {
        console.error('Transaction verification error:', error);
        return {
            success: false,
            message: 'An error occurred while verifying your payment. Please try again later.'
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