import axios from 'axios';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { config } from '../config/index.js';
import * as userRepo from '../repositories/user.repository.js';
import * as transactionRepo from '../repositories/transaction.repository.js';
import * as convoRepo from '../repositories/conversation.repository.js';
import * as assistantService from '../services/assistant.service.js';
import * as paystackService from '../services/paystack.service.js';
import { InsufficientTokensError } from '../utils/errors.js';
import { RequestState } from '../../models/requestState.js';
import { PaymentState } from '../../models/paymentState.js';
import VerificationState from '../../models/verificationState.js';
import { ensureConnection } from '../../db/connection.js';
import type { ConversationMessage } from '../types/index.js';

const META_API_BASE = 'https://graph.facebook.com/v21.0';

/* === Meta API Helpers === */

function metaHeaders() {
    return {
        Authorization: `Bearer ${config.metaAccessToken}`,
        'Content-Type': 'application/json',
    };
}

async function sendMetaRequest(endpoint: string, data: object): Promise<{ success: boolean; error?: string }> {
    try {
        const url = `${META_API_BASE}/${endpoint}`;
        await axios.post(url, data, { headers: metaHeaders() });
        return { success: true };
    } catch (error) {
        const axiosError = error as { response?: { data?: { error?: { message?: string } } }; message?: string };
        const msg = axiosError.response?.data?.error?.message ?? axiosError.message ?? 'Unknown error';
        console.error('Meta API error:', msg);
        return { success: false, error: msg };
    }
}

async function sendMsg(content: string, waId: string): Promise<void> {
    const chunks = splitMessage(content);
    const phoneNumber = waId.replace('wa:', '');

    for (let i = 0; i < chunks.length; i++) {
        let text = chunks[i];
        if (chunks.length > 1) {
            if (i === 0) text += '\n\n...';
            else if (i === chunks.length - 1) text = '...\n\n' + text;
            else text = '...\n\n' + text + '\n\n...';
        }

        const result = await sendMetaRequest(`${config.metaPhoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'text',
            text: { body: text },
        });

        if (!result.success) throw new Error(result.error ?? 'Failed to send message');
        if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 500));
    }
}

async function sendTemplate(
    templateName: string,
    languageCode: string,
    waId: string,
    variables: string[]
): Promise<void> {
    const phone = waId.replace('wa:', '');
    const components =
        variables.length > 0
            ? [{ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: v })) }]
            : [];

    const result = await sendMetaRequest(`${config.metaPhoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: { name: templateName, language: { code: languageCode }, components },
    });

    if (!result.success) throw new Error(result.error ?? 'Failed to send template');
}

async function downloadMedia(mediaId: string): Promise<Buffer> {
    const metaResponse = await axios.get(`${META_API_BASE}/${mediaId}`, { headers: metaHeaders() });
    const fileResponse = await axios.get(metaResponse.data.url as string, {
        headers: metaHeaders(),
        responseType: 'arraybuffer',
    });
    return Buffer.from(fileResponse.data as ArrayBuffer);
}

function splitMessage(text: string, maxLength = 1600): string[] {
    if (!text || text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let currentChunk = '';
    const paragraphs = text.split('\n\n');

    for (const paragraph of paragraphs) {
        if (currentChunk.length + paragraph.length + 2 > maxLength) {
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }
            if (paragraph.length > maxLength) {
                const sentences = paragraph.split(/(?<=[.!?])\s+/);
                for (const sentence of sentences) {
                    if (currentChunk.length + sentence.length + 1 > maxLength) {
                        if (currentChunk.trim()) {
                            chunks.push(currentChunk.trim());
                            currentChunk = '';
                        }
                        if (sentence.length > maxLength) {
                            for (const word of sentence.split(' ')) {
                                if (currentChunk.length + word.length + 1 > maxLength) {
                                    if (currentChunk.trim()) chunks.push(currentChunk.trim());
                                    currentChunk = word.length > maxLength
                                        ? (chunks.push(word.slice(0, maxLength)), word.slice(maxLength))
                                        : word;
                                } else {
                                    currentChunk += (currentChunk ? ' ' : '') + word;
                                }
                            }
                        } else {
                            currentChunk = sentence;
                        }
                    } else {
                        currentChunk += (currentChunk ? ' ' : '') + sentence;
                    }
                }
            } else {
                currentChunk = paragraph;
            }
        } else {
            currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
        }
    }

    if (currentChunk.trim()) chunks.push(currentChunk.trim());
    return chunks.filter((c) => c.trim().length > 0);
}

function computeConvoTitle(convoHistory: ConversationMessage[]): string {
    const firstUserMsg = convoHistory.find((m) => m.role === 'user');
    if (!firstUserMsg) return 'Conversation';
    if (typeof firstUserMsg.content === 'string') {
        const text = firstUserMsg.content;
        return text.substring(0, 20) + (text.length > 20 ? '...' : '');
    }
    if (Array.isArray(firstUserMsg.content) && firstUserMsg.content.length > 0) {
        return 'Conversation with attachment';
    }
    return 'Conversation';
}

/* === Webhook Verification === */

function verifyWebhook(req: VercelRequest, res: VercelResponse): void {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.metaVerifyToken) {
        console.log('Webhook verified successfully');
        res.status(200).send(challenge);
    } else {
        console.error('Webhook verification failed');
        res.status(403).send('Forbidden');
    }
}

/* === Payment Callback Page === */

function paymentCallbackPage(req: VercelRequest, res: VercelResponse): void {
    const reference = (req.query.reference as string) || (req.query.trxref as string) || '';
    res.status(200).send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payment Successful - Florence*</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
        .modal { background: white; border-radius: 12px; padding: 2rem; max-width: 400px; box-shadow: 0 4px 6px rgba(0,0,0,.1); text-align: center; }
        h1 { margin: 0 0 1rem; font-size: 1.5rem; color: #333; }
        p { font-size: .95rem; line-height: 1.5; color: #666; margin-bottom: 1.5rem; }
        .reference { background: #f5f5f5; padding: .75rem; border-radius: 6px; font-family: monospace; font-size: .85rem; color: #333; word-break: break-all; margin-bottom: 1.5rem; }
        .button { display: inline-block; background: #4da9ff; color: white; padding: .75rem 1.5rem; border-radius: 6px; text-decoration: none; font-weight: 500; }
    </style>
</head>
<body>
    <div class="modal">
        <h1>Payment Successful!</h1>
        <p>Your payment has been processed successfully. Your tokens will be added to your account shortly.</p>
        ${reference ? `<div class="reference">Reference: ${reference}</div>` : ''}
        <p>Please return to WhatsApp to continue using Florence*.</p>
        <a href="https://wa.me/19048335624" class="button">Close</a>
    </div>
</body>
</html>`);
}

/* === Message Processing === */

async function processMessage(req: VercelRequest, res: VercelResponse): Promise<void> {
    console.log('=== WhatsApp Webhook Received ===');

    let userId = '';

    try {
        const entry = (req.body as { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ id: string; from: string; type: string; text?: { body: string }; image?: { id: string; mime_type: string; caption?: string }; document?: { id: string; mime_type: string; caption?: string }; interactive?: { button_reply?: { title: string }; list_reply?: { title: string } } } >; contacts?: Array<{ profile?: { name?: string } }> } }> }>}).entry;
        const change = entry?.[0]?.changes?.[0];
        const message = change?.value?.messages?.[0];

        if (!message) {
            res.status(200).send('OK');
            return;
        }

        const messageId = message.id;
        const phoneNumber = message.from;
        const waId = `wa:${phoneNumber}`;
        const profileName = change?.value?.contacts?.[0]?.profile?.name || 'User';

        let body = '';
        let numMedia = 0;
        let mediaId: string | null = null;
        let mediaType: string | null = null;

        if (message.type === 'text') {
            body = message.text?.body || '';
        } else if (message.type === 'image') {
            numMedia = 1;
            mediaId = message.image!.id;
            mediaType = message.image!.mime_type;
            body = message.image!.caption || '';
        } else if (message.type === 'document') {
            numMedia = 1;
            mediaId = message.document!.id;
            mediaType = message.document!.mime_type;
            body = message.document!.caption || '';
        } else if (message.type === 'interactive') {
            body =
                message.interactive?.button_reply?.title ||
                message.interactive?.list_reply?.title ||
                '';
        } else {
            res.status(200).send('OK');
            return;
        }

        if (!waId || !messageId) {
            res.status(400).send('Missing required fields');
            return;
        }

        userId = waId;

        const existingRequest = await RequestState.findOne({ messageId });
        if (existingRequest) {
            res.status(200).send('OK');
            return;
        }

        await RequestState.create({ userId, messageId, status: 'processing' });

        let user = await userRepo.findUser(userId);

        if (!user) {
            user = await userRepo.createUser({ id: userId, name: profileName, tokens: 10 });
            await sendTemplate('main_menu_hxcc21ab7ce18151cf00d9db0ebcd3fb66', 'en', waId, [
                user.tokens.toString(),
            ]);
            res.status(200).send('OK');
            return;
        }

        const paymentState = await PaymentState.findOne({ userId });
        const ps = paymentState as unknown as { step: string; amount: number; tokens: number; email?: string; reference?: string; save(): Promise<void> } | null;

        if (ps && ps.step === 'bundle_select' && !body.startsWith('/')) {
            const choice = parseInt(body.trim());
            const bundle = paystackService.BUNDLES[choice - 1];

            if (!bundle) {
                await sendMsg(
                    `Please reply with a number between 1 and ${paystackService.BUNDLES.length} to choose your bundle.`,
                    waId
                );
                res.status(200).send('OK');
                return;
            }

            ps.amount = bundle.amount;
            ps.tokens = bundle.tokens;

            if (user.email) {
                ps.step = 'processing';
                await ps.save();
                await processWaPayment(userId, user.email, ps.amount, ps.tokens, waId, ps);
            } else {
                ps.step = 'email';
                await ps.save();
                await sendMsg(
                    'Please reply with your email address for payment receipt (we only need this once):',
                    waId
                );
            }
            res.status(200).send('OK');
            return;
        }

        if (ps && ps.step === 'email' && !body.startsWith('/')) {
            const email = body.trim();
            if (email.includes('@') && email.includes('.') && email.length > 5) {
                await userRepo.updateUser(userId, { email });
                ps.step = 'processing';
                ps.email = email;
                await ps.save();
                await processWaPayment(userId, email, ps.amount, ps.tokens, waId, ps);
                res.status(200).send('OK');
                return;
            } else {
                await PaymentState.deleteOne({ userId });
            }
        }

        if (ps && body.startsWith('/')) {
            await PaymentState.deleteOne({ userId });
        }

        if (numMedia > 0 && mediaId && mediaType) {
            const caption = body || 'Analyze this image/document.';

            if (user.tokens < 2) {
                await sendMsg("You don't have enough tokens for media upload. Send /payments to top up.", waId);
                res.status(200).send('OK');
                return;
            }

            try {
                const mediaBuffer = await downloadMedia(mediaId);
                const b64Media = mediaBuffer.toString('base64');

                if (!mediaType.startsWith('image/') && mediaType !== 'application/pdf') {
                    await sendMsg('Sorry, I can only process images and PDF documents.', waId);
                    res.status(200).send('OK');
                    return;
                }

                const response = await assistantService.processMediaMessage(
                    userId,
                    b64Media,
                    mediaType,
                    caption
                );
                await sendMsg(response, waId);
            } catch (error) {
                if (error instanceof InsufficientTokensError) {
                    await sendMsg("You don't have enough tokens for media upload. Send /payments to top up.", waId);
                } else {
                    console.error('Error processing media:', error);
                    const currentUser = await userRepo.findUser(userId);
                    if (currentUser) await userRepo.updateUser(userId, { tokens: currentUser.tokens + 2 });
                    await sendMsg('Sorry, there was an error processing your media. Your tokens have been refunded.', waId);
                }
            }
            res.status(200).send('OK');
            return;
        }

        await handleWaCommand(body, waId, userId, user, profileName, res);
    } catch (error) {
        console.error('Error processing WhatsApp message:', error);
        res.status(500).send('Error');
    }
}

async function processWaPayment(
    userId: string,
    email: string,
    amount: number,
    tokens: number,
    waId: string,
    state: { reference?: string; save(): Promise<void> }
): Promise<void> {
    const callbackUrl = `${config.webhookUrl}/api/wa/payment/callback`;
    const result = await paystackService.initializePayment(userId, email, amount, tokens, callbackUrl);

    if (result.success && result.reference) {
        state.reference = result.reference;
        await state.save();
        try {
            await sendTemplate('ccc_verify_hx53cdb954c4d2b7cfe550c771939b4ee8', 'en', waId, [result.reference]);
            await new Promise((r) => setTimeout(r, 500));
        } catch (templateError) {
            console.error('Template error:', templateError);
        }
        await sendMsg(
            `Complete your payment of ₦${amount.toLocaleString()} for ${tokens} tokens:\n${result.authorizationUrl}\n\nTokens are only added after you verify. Once you've paid, tap to copy:\n/verify ${result.reference}\n\nPaste it here to confirm and receive your tokens.`,
            waId
        );
    } else {
        await sendMsg('Payment initialization failed. Please try again.', waId);
    }
}

async function handleWaCommand(
    body: string,
    waId: string,
    userId: string,
    user: Awaited<ReturnType<typeof userRepo.findUser>> & object,
    profileName: string,
    res: VercelResponse
): Promise<void> {
    switch (body) {
        case '/start': {
            if (user!.convoHistory && user!.convoHistory.length > 0) {
                const title = computeConvoTitle(user!.convoHistory);
                await convoRepo.resetHistory(userId, title);
            } else {
                await convoRepo.resetHistory(userId);
            }
            await sendMsg(
                `Hello ${profileName}, welcome to Florence*! What do you need help with today?\n\nYou have ${user!.tokens} tokens.`,
                waId
            );
            res.status(200).send('OK');
            return;
        }

        case '/about': {
            await sendMsg(
                `Florence* is the educational assistant at your fingertips.\n\nI can help you with a variety of tasks, including:\n- Answering questions\n- Providing explanations\n- Offering study tips\n\nJust ask away!`,
                waId
            );
            res.status(200).send('OK');
            return;
        }

        case '/payments': {
            await PaymentState.findOneAndUpdate(
                { userId },
                { step: 'bundle_select', email: user!.email || null, createdAt: new Date() },
                { upsert: true, new: true }
            );
            const bundleList = paystackService.BUNDLES.map(
                (b, i) => `${i + 1}. ₦${b.amount.toLocaleString()} – ${b.tokens} tokens`
            ).join('\n');
            await sendMsg(
                `Please choose your bundle:\n\n${bundleList}\n\nReply with the number of your choice.`,
                waId
            );
            res.status(200).send('OK');
            return;
        }

        case '/tokens': {
            if (user!.tokens <= 5) {
                await sendMsg('You are running low on tokens. Top up by sending /payments.', waId);
            }
            await sendMsg(`Hey ${profileName.split(' ')[0]}, you have ${user!.tokens} tokens.`, waId);
            res.status(200).send('OK');
            return;
        }

        case '/streak': {
            await sendMsg(
                `Hey ${profileName.split(' ')[0]}, you are on a ${user!.streak}-day streak. Send one prompt a day to keep it going!`,
                waId
            );
            res.status(200).send('OK');
            return;
        }

        case '/transactions': {
            const transactions = await transactionRepo.findUserTransactions(userId);
            if (!transactions.length) {
                await sendMsg("You haven't made any transactions yet.", waId);
                res.status(200).send('OK');
                return;
            }

            let txMessage =
                transactions.length > 20
                    ? `You have ${transactions.length} transactions. Here's your complete history:\n\n`
                    : 'Transaction History with Florence*\n\n';

            for (const tx of transactions) {
                const date = tx.createdAt.toLocaleDateString('en-GB', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                });
                const time = tx.createdAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                txMessage += `• ${date} ${time}\n  ${tx.reference}\n  ₦${tx.amount} | +${tx.tokens} tokens`;
                if (tx.status !== 'success') txMessage += ` (${tx.status})`;
                txMessage += '\n\n';
            }

            await sendMsg(txMessage, waId);
            res.status(200).send('OK');
            return;
        }

        case '/conversations': {
            const convos = await convoRepo.getSavedConversations(userId);
            if (!convos.length) {
                await sendMsg('You have no saved conversations yet. Start a new one by sending a message!', waId);
                res.status(200).send('OK');
                return;
            }
            const lastFive = convos.slice(-5).reverse();
            let convoList = 'Your last 5 conversations:\n\n';
            lastFive.forEach((convo, index) => {
                convoList += `${index + 1}. ${convo.title || `Conversation ${index + 1}`}\n`;
            });
            await sendMsg(convoList, waId);
            res.status(200).send('OK');
            return;
        }

        case '/help': {
            await sendTemplate('main_menu_hxcc21ab7ce18151cf00d9db0ebcd3fb66', 'en', waId, [
                user!.tokens.toString(),
            ]);
            await sendMsg(
                `Here are the available commands:\n\n/start - Start a NEW conversation\n/about - Learn about Florence*\n/tokens - Check your token balance\n/payments - Buy more tokens\n/streak - Check your daily streak\n/transactions - View payment history\n/conversations - View recent conversations\n/verify [ref] - Verify a payment\n/help - Show this message`,
                waId
            );
            res.status(200).send('OK');
            return;
        }

        default: {
            if (body.startsWith('/verify')) {
                await handleWaVerify(body, userId, user!, waId);
                res.status(200).send('OK');
                return;
            }

            try {
                const response = await assistantService.processTextMessage(userId, body);
                await sendMsg(response, waId);
            } catch (error) {
                if (error instanceof InsufficientTokensError) {
                    await sendMsg('You have run out of tokens. Top up by sending /payments.', waId);
                } else {
                    console.error('Error processing WA message:', error);
                    await sendMsg('Sorry, something went wrong. Please try again.', waId);
                }
            }
            res.status(200).send('OK');
        }
    }
}

async function handleWaVerify(
    body: string,
    userId: string,
    user: NonNullable<Awaited<ReturnType<typeof userRepo.findUser>>>,
    waId: string
): Promise<void> {
    const parts = body.trim().split(/\s+/);
    let reference: string;

    if (parts.length < 2 || !parts[1]) {
        const pendingPayment = await transactionRepo
            .findUserTransactions(userId)
            .then((txs) => txs.find((tx) => tx.status === 'pending') ?? null);

        if (pendingPayment) {
            reference = pendingPayment.reference;
        } else {
            await sendMsg(
                `No pending payment found.\n\nIf you have a reference number, use:\n/verify [reference]`,
                waId
            );
            return;
        }
    } else {
        reference = parts.slice(1).join('').trim();
    }

    const existingVerification = await VerificationState.findOne({ userId, reference, status: 'verified' });
    if (existingVerification) {
        await sendMsg(
            `Already Verified\n\nThis payment reference has already been used.\nThe tokens were previously added to your account.\n\nCurrent balance: ${user.tokens} tokens`,
            waId
        );
        return;
    }

    const result = await paystackService.verifyTransaction(reference);

    if (result.success) {
        const newTokens = user.tokens + (result.tokens ?? 0);
        await userRepo.updateUser(userId, { tokens: newTokens });
        await VerificationState.create({
            userId,
            reference,
            status: 'verified',
            tokens: result.tokens,
            verifiedAt: new Date(),
        });
        await sendMsg(
            `Payment Verified!\n\nAdded: ${result.tokens} tokens\nNew balance: ${newTokens} tokens\n\nThank you for your payment!`,
            waId
        );
    } else if (result.isPending) {
        await sendMsg(`Bank Transfer\n\n${result.message}`, waId);
    } else {
        await sendMsg(`Verification Failed\n\n${result.message}`, waId);
    }
}

/* === Main Handler === */

export async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    try {
        await ensureConnection();

        const rawPath = req.url || '/';
        const path = rawPath.replace(/^\/api\/wa/, '') || '/';

        if (path === '/payment/callback' || path.startsWith('/payment/callback?')) {
            paymentCallbackPage(req, res);
            return;
        }

        if (req.method === 'GET') {
            verifyWebhook(req, res);
            return;
        }

        if (req.method === 'POST') {
            await processMessage(req, res);
            return;
        }

        res.status(405).send('Method not allowed');
    } catch (error) {
        console.error('WA handler error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}
