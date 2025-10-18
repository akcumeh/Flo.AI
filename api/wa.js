import express from 'express';
import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

import {
    walkThru,
    addUser,
    getUser,
    updateUser,
    askClaude,
    askClaudeWithAtt
} from '../utils/utils.js';
import { initializeCardPayment, verifyTransaction } from '../utils/paystack.js';
import { initFw, verifyFw } from '../utils/flutterwave.js';
import VerificationState from '../models/verificationState.js';
import { Transaction } from '../models/transactions.js';
import { RequestState, PaymentState } from '../models/serverless.js';
import fetch from 'node-fetch';

const router = express.Router();

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

function paystackRef(url) {
    const parts = url.split('/');
    return parts[parts.length - 1];
}

function fwRef(url) {
    const parts = url.split('/');
    return parts[parts.length - 1];
}

function splitMessage(text, maxLength = 1600) {
    if (!text || text.length <= maxLength) {
        return [text];
    }

    const chunks = [];
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
                            const words = sentence.split(' ');

                            for (const word of words) {
                                if (currentChunk.length + word.length + 1 > maxLength) {
                                    if (currentChunk.trim()) {
                                        chunks.push(currentChunk.trim());
                                        currentChunk = '';
                                    }

                                    if (word.length > maxLength) {
                                        for (let j = 0; j < word.length; j += maxLength) {
                                            chunks.push(word.slice(j, j + maxLength));
                                        }
                                    } else {
                                        currentChunk = word;
                                    }
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

    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    return chunks.filter(chunk => chunk.trim().length > 0);
}

async function sendMsg(content, id) {
    try {
        const chunks = splitMessage(content);

        for (let i = 0; i < chunks.length; i++) {
            let messageText = chunks[i];

            if (chunks.length > 1) {
                if (i === 0) {
                    messageText += '\n\n...';
                } else if (i === chunks.length - 1) {
                    messageText = '...\n\n' + messageText;
                } else {
                    messageText = '...\n\n' + messageText + '\n\n...';
                }
            }

            await client.messages.create({
                body: messageText,
                from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
                to: id
            });

            if (i < chunks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        return { success: true };
    } catch (error) {
        console.error('Error sending WA message', error);
        throw error;
    }
}

async function downloadMedia(mediaUrl) {
    try {
        const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');

        const response = await fetch(mediaUrl, {
            headers: {
                'Authorization': `Basic ${auth}`
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to download media: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        return Buffer.from(buffer);
    } catch (error) {
        console.error('Error downloading media:', error);
        throw error;
    }
}

router.post('/', async (req, res) => {
    console.log('=== WhatsApp Webhook Received ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));

    let userId;
    let user;

    try {
        const MessageSid = req.body.MessageSid || req.body.SmsMessageSid;
        const WaId = req.body.From;
        const ProfileName = req.body.ProfileName || 'User';
        const Body = req.body.Body || '';
        const NumMedia = parseInt(req.body.NumMedia) || 0;

        console.log('Parsed values:', { MessageSid, WaId, ProfileName, Body, NumMedia });

        if (!WaId || !MessageSid) {
            console.error('ERROR: Missing required fields');
            return res.status(400).send('Missing required fields');
        }

        userId = WaId.replace('whatsapp:', 'wa:');

        const existingRequest = await RequestState.findOne({
            messageId: MessageSid
        });

        if (existingRequest) {
            console.log('Duplicate message detected, skipping:', MessageSid);
            return res.status(200).send('OK');
        }

        await RequestState.create({
            userId,
            messageId: MessageSid,
            status: 'processing'
        });

        console.log('Looking up user:', userId);
        user = await getUser(userId);

        if (!user) {
            console.log('New user detected, creating account...');
            user = await addUser({
                id: userId,
                name: ProfileName,
                tokens: 10
            });
            console.log('User created:', user.userId);

            console.log('Sending welcome message with template...');
            await client.messages.create({
                from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
                contentSid: process.env.TWILIO_MENU_SID,
                contentVariables: JSON.stringify({
                    "1": user.tokens.toString()
                }),
                to: WaId
            });
            console.log('Welcome template sent successfully');
            return res.status(200).send('OK');
        }

        console.log('Existing user found:', user.userId, 'Tokens:', user.tokens);

        const paymentState = await PaymentState.findOne({ userId });

        if (paymentState && paymentState.step === 'email' && !Body.startsWith('/')) {
            const email = Body.trim();

            if (email.includes('@') && email.includes('.') && email.length > 5) {
                await updateUser(userId, { email });
                paymentState.step = 'processing';
                paymentState.email = email;
                await paymentState.save();

                const callbackUrl = `${process.env.WEBHOOK_URL}/wa/payment/callback`;

                const [paystackResult, fwResult] = await Promise.all([
                    initializeCardPayment({ userId, email }, 1000, callbackUrl),
                    initFw({ userId, email, name: ProfileName }, 1000, callbackUrl)
                ]);

                if (paystackResult.success && fwResult.success) {
                    paymentState.paystackReference = paystackResult.reference;
                    paymentState.flutterwaveReference = fwResult.reference;
                    await paymentState.save();

                    console.log('Paystack URL:', paystackResult.authorizationUrl);
                    console.log('Flutterwave URL:', fwResult.paymentLink);

                    const psCode = paystackRef(paystackResult.authorizationUrl);
                    const fwCode = fwRef(fwResult.paymentLink);

                    console.log('Extracted Paystack code:', psCode);
                    console.log('Extracted Flutterwave code:', fwCode);

                    await client.messages.create({
                        from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
                        contentSid: process.env.TWILIO_PAYMENTS_SID,
                        contentVariables: JSON.stringify({
                            "1": psCode,
                            "2": fwCode
                        }),
                        to: WaId
                    });

                    await client.messages.create({
                        from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
                        contentSid: process.env.TWILIO_VERIFY_SID,
                        contentVariables: JSON.stringify({
                            "1": paystackResult.reference
                        }),
                        to: WaId
                    });
                } else {
                    await sendMsg('Payment initialization failed. Please try again.', WaId);
                }
                return res.status(200).send('OK');
            } else {
                await PaymentState.deleteOne({ userId });
            }
        }

        if (paymentState && Body.startsWith('/')) {
            await PaymentState.deleteOne({ userId });
        }

        if (NumMedia > 0) {
            const mediaUrl = req.body.MediaUrl0;
            const mediaType = req.body.MediaContentType0;
            const caption = Body || "Analyze this image/document.";

            if (user.tokens < 2) {
                await sendMsg(
                    `You don't have enough tokens for media upload. Send /payments to top up.`,
                    WaId
                );
                return res.status(200).send('OK');
            }

            await updateUser(userId, { tokens: user.tokens - 2 });

            try {
                const mediaBuffer = await downloadMedia(mediaUrl);
                const b64Media = mediaBuffer.toString('base64');

                let fileType;
                if (mediaType.startsWith('image/')) {
                    fileType = ['image', mediaType];
                } else if (mediaType === 'application/pdf') {
                    fileType = ['document', 'application/pdf'];
                } else {
                    await updateUser(userId, { tokens: user.tokens });
                    await sendMsg(
                        `Sorry, I can only process images and PDF documents.`,
                        WaId
                    );
                    return res.status(200).send('OK');
                }

                const response = await askClaudeWithAtt(user, b64Media, fileType, caption);

                const freshUser = await getUser(userId);
                const newConvoHistory = [
                    ...(freshUser.convoHistory || []),
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: caption
                            },
                            {
                                type: fileType[0],
                                source: {
                                    type: "base64",
                                    media_type: fileType[1],
                                    data: b64Media
                                }
                            }
                        ]
                    },
                    {
                        role: "assistant",
                        content: response
                    }
                ];

                await updateUser(userId, { convoHistory: newConvoHistory });
                await sendMsg(response, WaId);
                return res.status(200).send('OK');

            } catch (error) {
                console.error('Error processing media:', error);
                await updateUser(userId, { tokens: user.tokens });
                await sendMsg(
                    `Sorry, there was an error processing your media. Your tokens have been refunded.`,
                    WaId
                );
                return res.status(200).send('OK');
            }
        }

        console.log('Processing message. Body:', Body);

        switch (Body) {
            case '/start':
                console.log('Processing /start command');

                if (user.convoHistory && user.convoHistory.length > 0) {
                    let title = "Conversation";

                    const firstUserMessage = user.convoHistory.find(msg => msg.role === "user");

                    if (firstUserMessage) {
                        if (typeof firstUserMessage.content === 'string') {
                            title = firstUserMessage.content.substring(0, 20) +
                                (firstUserMessage.content.length > 20 ? "..." : "");
                        } else if (Array.isArray(firstUserMessage.content) && firstUserMessage.content.length > 0) {
                            title = "Conversation with attachment";
                        }
                    }

                    if (!user.convos) user.convos = [];

                    user.convos.push({
                        title: title,
                        messages: [...user.convoHistory]
                    });

                    await updateUser(userId, { convos: user.convos });
                }

                await updateUser(userId, { convoHistory: [] });
                await sendMsg(
                    `Hello ${ProfileName}, welcome to Florence*! What do you need help with today?\n\n` +
                    `You have ${user.tokens} tokens.`,
                    WaId
                );
                console.log('/start response sent');
                return res.status(200).send('OK');

            case '/about':
                await sendMsg(
                    `Florence* is the educational assistant at your fingertips.\n\nI can help you with a variety of tasks, including:\n- Answering questions\n- Providing explanations\n- Offering study tips\n\nJust ask away!`,
                    WaId
                );
                return res.status(200).send('OK');

            case '/payments':
                const existingPaymentState = await PaymentState.findOneAndUpdate(
                    { userId },
                    {
                        step: user.email ? 'processing' : 'email',
                        amount: 1000,
                        tokens: 10,
                        email: user.email,
                        createdAt: new Date()
                    },
                    { upsert: true, new: true }
                );

                if (user.email) {
                    const callbackUrl = `${process.env.WEBHOOK_URL}/wa/payment/callback`;

                    const [paystackResult, fwResult] = await Promise.all([
                        initializeCardPayment({ userId, email: user.email }, 1000, callbackUrl),
                        initFw({ userId, email: user.email, name: ProfileName }, 1000, callbackUrl)
                    ]);

                    if (paystackResult.success && fwResult.success) {
                        existingPaymentState.paystackReference = paystackResult.reference;
                        existingPaymentState.flutterwaveReference = fwResult.reference;
                        await existingPaymentState.save();

                        console.log('Paystack URL:', paystackResult.authorizationUrl);
                        console.log('Flutterwave URL:', fwResult.paymentLink);

                        const psCode = paystackRef(paystackResult.authorizationUrl);
                        const fwCode = fwRef(fwResult.paymentLink);

                        console.log('Extracted Paystack code:', psCode);
                        console.log('Extracted Flutterwave code:', fwCode);

                        await client.messages.create({
                            from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
                            contentSid: process.env.TWILIO_PAYMENTS_SID,
                            contentVariables: JSON.stringify({
                                "1": psCode,
                                "2": fwCode
                            }),
                            to: WaId
                        });

                        await client.messages.create({
                            from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
                            contentSid: process.env.TWILIO_VERIFY_SID,
                            contentVariables: JSON.stringify({
                                "1": paystackResult.reference
                            }),
                            to: WaId
                        });
                    } else {
                        await sendMsg('Payment initialization failed. Please try again.', WaId);
                    }
                } else {
                    await sendMsg(
                        `Please reply with your email address for payment receipt (we only need this once):`,
                        WaId
                    );
                }
                return res.status(200).send('OK');

            case '/tokens':
                if (user.tokens <= 5) {
                    await sendMsg(
                        `You are running low on tokens. Top up by sending /payments.`,
                        WaId
                    );
                }
                await sendMsg(
                    `Hey ${ProfileName.split(' ')[0]}, you have ${user.tokens} tokens.`,
                    WaId
                );
                return res.status(200).send('OK');

            case '/streak':
                await sendMsg(
                    `Hey ${ProfileName.split(' ')[0]}, you are on a ${user.streak}-day streak. Send one prompt a day to keep it going!`,
                    WaId
                );
                return res.status(200).send('OK');

            case '/transactions':
                const transactions = await Transaction.find({ userId }).sort({ createdAt: -1 });

                if (!transactions || transactions.length === 0) {
                    await sendMsg('You haven\'t made any transactions yet.', WaId);
                    return res.status(200).send('OK');
                }

                let txMessage = 'Transaction History with Florence*\n\n';
                transactions.forEach((tx) => {
                    const date = tx.createdAt.toLocaleDateString('en-GB', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric'
                    });
                    const time = tx.createdAt.toLocaleTimeString('en-GB', {
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                    txMessage += `• ${date} ${time}\n`;
                    txMessage += `  ${tx.reference}\n`;
                    txMessage += `  ₦${tx.amount} | +${tx.tokens} tokens`;
                    if (tx.status !== 'success') {
                        txMessage += ` (${tx.status})`;
                    }
                    txMessage += '\n\n';
                });

                if (transactions.length > 20) {
                    txMessage = `You have ${transactions.length} transactions. Here's your complete history:\n\n` + txMessage;
                }

                await sendMsg(txMessage, WaId);
                return res.status(200).send('OK');

            case '/conversations':
                if (!user.convos || user.convos.length === 0) {
                    await sendMsg(
                        `You have no saved conversations yet. Start a new one by sending a message!`,
                        WaId
                    );
                    return res.status(200).send('OK');
                }

                const lastFive = user.convos.slice(-5).reverse();
                let convoList = 'Your last 5 conversations:\n\n';
                lastFive.forEach((convo, index) => {
                    convoList += `${index + 1}. ${convo.title || `Conversation ${index + 1}`}\n`;
                });

                await sendMsg(convoList, WaId);
                return res.status(200).send('OK');

            case '/help':
                await client.messages.create({
                    from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
                    contentSid: process.env.TWILIO_MENU_SID,
                    contentVariables: JSON.stringify({
                        "1": user.tokens.toString()
                    }),
                    to: WaId
                });

                await sendMsg(
                    `Here are the available commands:\n\n` +
                    `/start - Start a NEW conversation\n` +
                    `/about - Learn about Florence*\n` +
                    `/tokens - Check your token balance\n` +
                    `/payments - Buy more tokens\n` +
                    `/streak - Check your daily streak\n` +
                    `/transactions - View payment history\n` +
                    `/conversations - View recent conversations\n` +
                    `/verify [ref] - Verify a payment\n` +
                    `/help - Show this message`,
                    WaId
                );
                return res.status(200).send('OK');

            default:
                if (Body.startsWith('/verify')) {
                    const parts = Body.trim().split(/\s+/);
                    let reference;

                    if (parts.length < 2 || !parts[1]) {
                        const pendingPayment = await Transaction.findOne({
                            userId,
                            status: 'pending'
                        }).sort({ createdAt: -1 });

                        if (pendingPayment) {
                            reference = pendingPayment.reference;
                            console.log('Auto-detected pending payment:', reference);
                        } else {
                            await sendMsg(
                                `No pending payment found.\n\nIf you have a reference number, use:\n/verify [reference]`,
                                WaId
                            );
                            return res.status(200).send('OK');
                        }
                    } else {
                        reference = parts.slice(1).join('').trim();
                    }

                    const existingVerification = await VerificationState.findOne({
                        userId,
                        reference,
                        status: 'verified'
                    });

                    if (existingVerification) {
                        await sendMsg(
                            `Already Verified\n\nThis payment reference has already been used.\nThe tokens were previously added to your account.\n\nCurrent balance: ${user.tokens} tokens`,
                            WaId
                        );
                        return res.status(200).send('OK');
                    }

                    let verificationResult = await verifyTransaction(reference);

                    if (!verificationResult.success) {
                        verificationResult = await verifyFw(reference);
                    }

                    if (verificationResult.success) {
                        const newTokens = user.tokens + verificationResult.tokens;
                        await updateUser(userId, { tokens: newTokens });

                        await VerificationState.create({
                            userId,
                            reference,
                            status: 'verified',
                            tokens: verificationResult.tokens,
                            verifiedAt: new Date()
                        });

                        await sendMsg(
                            `Payment Verified!\n\nAdded: ${verificationResult.tokens} tokens\nNew balance: ${newTokens} tokens\n\nThank you for your payment!`,
                            WaId
                        );
                    } else if (verificationResult.isPending) {
                        await sendMsg(
                            `Bank Transfer\n\n${verificationResult.message}`,
                            WaId
                        );
                    } else {
                        await sendMsg(
                            `Verification Failed\n\n${verificationResult.message}`,
                            WaId
                        );
                    }
                    return res.status(200).send('OK');
                }
                if (user.tokens < 1) {
                    await sendMsg(
                        `You have run out of tokens. Top up by sending /payments.`,
                        WaId
                    );
                    return res.status(200).send('OK');
                }

                await updateUser(userId, { tokens: user.tokens - 1 });

                const freshUser = await getUser(userId);
                const response = await askClaude(freshUser, Body);

                const newConvoHistory = [
                    ...(freshUser.convoHistory || []),
                    { role: "user", content: Body },
                    { role: "assistant", content: response }
                ];

                await updateUser(userId, { convoHistory: newConvoHistory });
                await sendMsg(response, WaId);
                return res.status(200).send('OK');
        }
    } catch (error) {
        console.error('Error processing command', error);
        res.status(500).send('Error')
    }
});

router.get('/', (_req, res) => {
    res.status(200).send('WhatsApp bot is running');
});

router.get('/payment/callback', (req, res) => {
    const reference = req.query.reference || req.query.trxref;

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Payment Successful - Florence*</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    margin: 0;
                    background: #f5f5f5;
                }
                .modal {
                    background: white;
                    border-radius: 12px;
                    padding: 2rem;
                    max-width: 400px;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    text-align: center;
                }
                h1 {
                    margin: 0 0 1rem 0;
                    font-size: 1.5rem;
                    color: #333;
                }
                p {
                    font-size: 0.95rem;
                    line-height: 1.5;
                    color: #666;
                    margin-bottom: 1.5rem;
                }
                .reference {
                    background: #f5f5f5;
                    padding: 0.75rem;
                    border-radius: 6px;
                    font-family: monospace;
                    font-size: 0.85rem;
                    color: #333;
                    word-break: break-all;
                    margin-bottom: 1.5rem;
                }
                .button {
                    display: inline-block;
                    background: #4da9ff;
                    color: white;
                    padding: 0.75rem 1.5rem;
                    border-radius: 6px;
                    text-decoration: none;
                    font-weight: 500;
                }
            </style>
        </head>
        <body>
            <div class="modal">
                <h1>Payment Successful!</h1>
                <p>Your payment has been processed successfully. Your tokens will be added to your account shortly.</p>
                ${reference ? `<div class="reference">Reference: ${reference}</div>` : ''}
                <p>Please return to WhatsApp to continue using Florence*.</p>
                <a href="https://wa.me/${process.env.TWILIO_PHONE_NUMBER?.replace('+', '')}" class="button">Close</a>
            </div>
        </body>
        </html>
    `);
});

export default router;