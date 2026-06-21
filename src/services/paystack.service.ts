import fetch, { type RequestInit as NodeFetchRequestInit } from 'node-fetch';
import crypto from 'crypto';
import { config } from '../config/index.js';
import { createTransaction } from '../repositories/transaction.repository.js';
import type { TokenBundle, PaymentResult, VerificationResult } from '../types/index.js';
import { Transaction } from '../../models/transactions.js';
import { ensureConnection } from '../../db/connection.js';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

export const BUNDLES: TokenBundle[] = [
    { amount: 500, tokens: 4 },
    { amount: 1000, tokens: 10 },
    { amount: 2500, tokens: 28 },
    { amount: 5000, tokens: 60 },
    { amount: 10000, tokens: 130 },
    { amount: 25000, tokens: 350 },
];

function getNumericUserId(userId: string): string {
    const matches = userId.match(/[^:,-]+$/);
    const extracted = matches ? matches[0] : userId;
    return extracted.replace(/[^0-9]/g, '');
}

async function paystackRequest(endpoint: string, method = 'GET', data: object | null = null) {
    const options: NodeFetchRequestInit = {
        method,
        headers: {
            Authorization: `Bearer ${config.paystackSecretKey}`,
            'Content-Type': 'application/json',
        },
    };

    if (data && (method === 'POST' || method === 'PUT')) {
        options.body = JSON.stringify(data);
    }

    const response = await fetch(`${PAYSTACK_BASE_URL}${endpoint}`, options);
    return await response.json() as Record<string, unknown>;
}

export async function initializePayment(
    userId: string,
    email: string | undefined,
    amount: number,
    tokens: number,
    callbackUrl: string
): Promise<PaymentResult> {
    try {
        const numericUserId = getNumericUserId(userId);
        const reference = `FLO-PAY-${Date.now()}-${numericUserId}`;

        const payload = {
            email: email ?? `${numericUserId}@placeholder.com`,
            amount: amount * 100,
            reference,
            callback_url: callbackUrl,
            metadata: { user_id: userId, payment_type: 'token_purchase', tokens },
        };

        const response = await paystackRequest('/transaction/initialize', 'POST', payload);

        if (response.status) {
            const data = response.data as Record<string, string>;
            await createTransaction({ userId, reference, amount, tokens, email, metadata: { authorizationUrl: data.authorization_url } });
            return {
                success: true,
                message: 'Payment initialized',
                authorizationUrl: data.authorization_url,
                reference: data.reference,
            };
        }

        return { success: false, message: `Payment initialization failed: ${response.message}` };
    } catch (error) {
        console.error('Payment initialization error:', error);
        return { success: false, message: 'An error occurred while initializing payment' };
    }
}

export async function verifyTransaction(reference: string): Promise<VerificationResult> {
    try {
        await ensureConnection();

        if (!reference) {
            return { success: false, message: 'Please provide a valid reference number.' };
        }

        const cleanReference = reference.replace(/[^a-zA-Z0-9-]/g, '');
        const transaction = await Transaction.findOne({ reference: cleanReference });

        if (!transaction) {
            return { success: false, message: 'Transaction not found. Please check your reference number.' };
        }

        if ((transaction as unknown as { hasExpired(): boolean }).hasExpired() && transaction.status === 'pending') {
            transaction.status = 'failed';
            await transaction.save();
            return { success: false, message: 'This payment link has expired. Please initiate a new payment.' };
        }

        if (cleanReference.includes('FLO-BANK')) {
            return {
                success: false,
                isPending: true,
                message: 'Bank transfer payments require manual verification. We will confirm your payment within 24 hours.',
            };
        }

        if (transaction.status === 'success') {
            return {
                success: true,
                message: 'Payment verified successfully',
                amount: transaction.amount,
                tokens: transaction.tokens,
                userId: transaction.userId,
            };
        }

        if (transaction.status === 'failed') {
            return { success: false, message: 'This payment was not completed. Please try making a new payment.' };
        }

        const response = await paystackRequest(`/transaction/verify/${cleanReference}`);
        const responseData = response.data as Record<string, unknown>;

        if (response.status && responseData.status === 'success') {
            transaction.status = 'success';
            transaction.completedAt = new Date();
            transaction.gatewayResponse = responseData;
            await transaction.save();

            return {
                success: true,
                message: 'Payment verified successfully',
                amount: (responseData.amount as number) / 100,
                tokens: transaction.tokens,
                userId: transaction.userId,
            };
        }

        return {
            success: false,
            message: 'Payment not yet received. If you just made the payment, please wait a few minutes and try again.',
        };
    } catch (error) {
        console.error('Transaction verification error:', error);
        return { success: false, message: 'An error occurred while verifying your payment. Please try again later.' };
    }
}

export function verifyWebhookSignature(requestBody: object, signature: string): boolean {
    try {
        const hash = crypto
            .createHmac('sha512', config.paystackSecretKey)
            .update(JSON.stringify(requestBody))
            .digest('hex');
        return hash === signature;
    } catch (error) {
        console.error('Webhook signature verification error:', error);
        return false;
    }
}
