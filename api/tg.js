import express from 'express';
import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import { getMessageContent, downloadTelegramFile } from '../utils/getMsgContent.js';
import {
    initializeCardPayment,
    initializeBankTransfer,
    verifyTransaction
} from '../utils/paystack.js';
import crypto from 'crypto';

dotenv.config();

const router = express.Router();
const prefix = 'tg-';

// Import utils
import {
    walkThru,
    addUser,
    getUser,
    updateUser,
    askClaude,
    askClaudeWithAtt,
    convertImgToBase64,
    convertPDFToBase64,
} from '../utils/utils.js';
import { User } from '../models/user.js';
import { Transaction } from '../models/transactions.js';
import Anthropic from '@anthropic-ai/sdk';
import { message } from 'telegraf/filters';

// Create bot with token from .env file
const bot = new Telegraf(process.env.BOT_TOKEN);

// User payment states for managing the payment flow
const paymentStates = new Map();

// ====== Bot Commands ======
bot.command('start', async (ctx) => {
    try {
        console.log('Received /start command from', ctx.from.id);
        const userId = prefix + ctx.from.id;

        // Check if user exists in database
        let user = await getUser(userId);

        if (!user) {
            console.log('Creating new user:', userId);
            user = await addUser({
                id: userId,
                name: ctx.from.first_name,
                tokens: 25
            });
            await ctx.reply(walkThru(user.tokens));
        }

        // Save existing conversation if it exists and has messages
        if (user.convoHistory && user.convoHistory.length > 0) {
            try {
                let anthropic = new Anthropic({
                    apiKey: process.env.CLAUDE_API_KEY
                });
                const title = await anthropic.messages.create({
                    model: "claude-3-5-sonnet-latest",
                    max_tokens: 1024,
                    system: "In 5-7 words ONLY, title the following conversation.",
                    messages: [
                        {
                            role: "user",
                            content: "In 5-10 words ONLY, title the following conversation.\n\n" + user.convoHistory.map(msg => `${msg.role}: ${msg.content}`).join('\n')
                        }
                    ],
                });
                const convoTitle = title.content[0].text;

                // Add current conversation to the list
                if (!user.convos) user.convos = [];
                user.convos.push({
                    title: convoTitle,
                    messages: [...user.convoHistory]
                });

                // Update user in database
                await updateUser(userId, { convos: user.convos });
            } catch (error) {
                console.error('Error generating conversation title:', error);
                // If title generation fails, use default title
                if (!user.convos) user.convos = [];
                user.convos.push({
                    title: `Conversation ${user.convos.length + 1}`,
                    messages: [...user.convoHistory]
                });

                // Update user in database
                await updateUser(userId, { convos: user.convos });
            }
        }

        // Reset conversation
        user.convoHistory = [];
        await updateUser(userId, { convoHistory: [] });
        await ctx.reply(`Hello ${ctx.from.first_name}, welcome to Florence*! What do you need help with today?\n\nYou have ${user.tokens} tokens.`);
    } catch (error) {
        console.error('Error in /start command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('about', async (ctx) => {
    await ctx.reply('Florence* is the educational assistant at your fingertips.\n\nI can help you with a variety of tasks, including:\n- Answering questions\n- Providing explanations\n- Offering study tips\n\nJust ask away!');
});

bot.command('tokens', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        const user = await getUser(userId);
        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }
        await ctx.reply(`You have ${user.tokens} tokens. To top up, send /payments.`);
    } catch (error) {
        console.error('Error in /tokens command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

// Payment command handler
bot.command('payments', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        const user = await getUser(userId);

        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        // Initialize payment state
        paymentStates.set(userId, {
            step: 'init',
            amount: 1000, // Default amount in Naira
            tokens: 25    // Default tokens to purchase
        });

        await ctx.reply(
            'Tokens cost 1,000 naira for 25 tokens.\n\n' +
            'Choose a payment method:',
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: 'Pay with Card', callback_data: 'payment_card' },
                            { text: 'Bank Transfer', callback_data: 'payment_bank' }
                        ]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Error in /payments command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

// Transaction history command
bot.command('transactions', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        const user = await getUser(userId);

        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        const transactions = await Transaction.find({ userId }).sort({ createdAt: -1 }).limit(5);

        if (!transactions || transactions.length === 0) {
            return ctx.reply('You haven\'t made any transactions yet.');
        }

        let message = 'Your recent transactions:\n\n';

        transactions.forEach((tx, index) => {
            message += `${index + 1}. ${tx.amount} NGN for ${tx.tokens} tokens\n`;
            message += `   Status: ${tx.status}\n`;
            message += `   Date: ${tx.createdAt.toLocaleDateString()}\n`;
            if (index < transactions.length - 1) message += '\n';
        });

        await ctx.reply(message);
    } catch (error) {
        console.error('Error in /transactions command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

// Handle callback queries for payment method selection
bot.action('payment_card', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        const user = await getUser(userId);
        const state = paymentStates.get(userId);

        if (!user || !state) {
            return ctx.reply('Session expired. Please start again with /payments.');
        }

        // Update payment state
        state.step = 'email';
        state.method = 'card';
        paymentStates.set(userId, state);

        await ctx.answerCbQuery();
        await ctx.reply('Please enter your email address for payment receipt:');
    } catch (error) {
        console.error('Error in card payment handler:', error);
        await ctx.answerCbQuery('An error occurred');
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.action('payment_bank', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        const user = await getUser(userId);
        const state = paymentStates.get(userId);

        if (!user || !state) {
            return ctx.reply('Session expired. Please start again with /payments.');
        }

        // Update payment state
        state.step = 'email';
        state.method = 'bank';
        paymentStates.set(userId, state);

        await ctx.answerCbQuery();
        await ctx.reply('Please enter your email address for payment receipt:');
    } catch (error) {
        console.error('Error in bank transfer handler:', error);
        await ctx.answerCbQuery('An error occurred');
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

// Payment verification command
bot.command('verify', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        const user = await getUser(userId);

        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        // Get reference from command
        const parts = ctx.message.text.split(' ');
        if (parts.length < 2) {
            return ctx.reply('Please provide a reference number: /verify REFERENCE');
        }

        const reference = parts[1].trim();

        // Send verification message
        const verifyMsg = await ctx.reply('Verifying your payment...');

        // Log verification attempt
        console.log(`User ${userId} is verifying payment with reference: ${reference}`);

        // Set NODE_ENV to development for testing if needed
        if (!process.env.NODE_ENV) {
            process.env.NODE_ENV = 'development';
        }

        // Verify transaction
        const verificationResult = await verifyTransaction(reference);

        console.log('Verification result:', verificationResult);

        if (verificationResult.success) {
            // Add tokens to user
            const newTokens = user.tokens + verificationResult.tokens;
            await updateUser(userId, { tokens: newTokens });

            await ctx.reply(
                `Payment verified successfully! ✅\n\n` +
                `${verificationResult.tokens} tokens have been added to your account.\n\n` +
                `You now have ${newTokens} tokens.`
            );

            // Clear payment state
            paymentStates.delete(userId);
        } else {
            await ctx.reply(`Payment verification failed: ${verificationResult.message}`);
        }
    } catch (error) {
        console.error('Error in verify command:', error);
        await ctx.reply('Sorry, something went wrong with payment verification. Please try again or contact support.');
    }
});

bot.command('conversations', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        const user = await getUser(userId);
        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        // Initialize conversations array if it doesn't exist
        if (!user.convos || !Array.isArray(user.convos)) {
            user.convos = [];
            await updateUser(userId, { convos: [] });
        }

        // List conversations
        if (user.convos.length === 0) {
            return ctx.reply('You have no saved conversations yet. Start a new one by sending a message!');
        }

        // Create buttons for each conversation
        const buttons = user.convos.map((convo, index) => {
            return [Markup.button.callback(convo.title || `Conversation ${index + 1}`, `convo_${index}`)];
        });

        await ctx.reply('Your saved conversations:', Markup.inlineKeyboard(buttons));
    } catch (error) {
        console.error('Error in /conversations command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('STEM', async (ctx) => {
    ctx.reply("This feature is coming soon :)")
});

bot.command('research', async (ctx) => {
    ctx.reply("The research feature is coming soon :)")
});

// Handle conversation selection callbacks
bot.action(/convo_(\d+)/, async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        const user = await getUser(userId);
        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        const convoIndex = parseInt(ctx.match[1], 10);
        if (!user.convos || !user.convos[convoIndex]) {
            return ctx.answerCbQuery('Conversation not found');
        }

        // Load the selected conversation
        await updateUser(userId, { convoHistory: [...user.convos[convoIndex].messages] });

        await ctx.answerCbQuery(`Loaded: ${user.convos[convoIndex].title}`);
        await ctx.reply(`Loaded conversation: "${user.convos[convoIndex].title}"\nYou can now continue where you left off.`);
    } catch (error) {
        console.error('Error handling conversation selection:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

// Handle photos
bot.on(message('photo'), async (ctx) => {
    const userId = prefix + ctx.from.id;
    let user = await getUser(userId);

    if (!user) {
        user = await addUser({
            id: userId,
            name: ctx.from.first_name,
            tokens: 25
        });
        await ctx.reply(walkThru(user.tokens));
        return;
    }

    if (user.tokens < 2) {
        return ctx.reply('You don\'t have enough tokens for an image upload. Send /payments to top up.');
    }

    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const caption = ctx.message.caption || "Assess the following image.";

    try {
        const imgBuffer = await downloadTelegramFile(bot, fileId);
        console.log("Received image of size", imgBuffer.length);

        // For Telegram photos, hardcode the MIME type as JPEG
        const mimeType = ctx.message.photo[ctx.message.photo.length - 1].mime_type || 'image/jpeg';
        let b64img = Buffer.from(imgBuffer).toString('base64');

        // Send "thinking" message
        await ctx.reply('Thinking...');

        // Update tokens before processing
        user.tokens -= 2;
        await updateUser(userId, { tokens: user.tokens });

        // Call Claude with the image
        let claudeAnswer = await askClaudeWithAtt(user, b64img, ['image', mimeType], caption);

        // Check if we received a valid answer
        if (!claudeAnswer) {
            throw new Error('No valid response received from Claude');
        }

        await ctx.reply(claudeAnswer);
    } catch (error) {
        console.error('Error processing image:', error);
        // Refund token on error
        user.tokens += 2;
        await updateUser(userId, { tokens: user.tokens });
        await ctx.reply('Sorry, there was an error processing your image. Your tokens have been refunded.');
    }
});

// Handle documents (PDFs, etc.)
bot.on(message('document'), async (ctx) => {
    const userId = prefix + ctx.from.id;
    let user = await getUser(userId);

    if (!user) {
        user = await addUser({
            id: userId,
            name: ctx.from.first_name,
            tokens: 25
        });
        await ctx.reply(walkThru(user.tokens));
        return;
    }

    if (user.tokens < 2) {
        return ctx.reply('You don\'t have enough tokens for a document upload. Send /payments to top up.');
    }

    const fileId = ctx.message.document.file_id;
    const fileName = ctx.message.document.file_name || "document";
    const mimeType = ctx.message.document.mime_type || "application/octet-stream";
    const caption = ctx.message.caption || `Analyze this ${fileName} document.`;

    try {
        const fileBuffer = await downloadTelegramFile(bot, fileId);
        console.log(`Received document of size ${fileBuffer.length}, type: ${mimeType}`);

        // Send "thinking" message
        await ctx.reply('Thinking...');

        // Update tokens before processing
        user.tokens -= 2;
        await updateUser(userId, { tokens: user.tokens });

        let claudeAnswer = await askClaudeWithAtt(user, fileBuffer.toString('base64'), ['document', mimeType], caption);

        await ctx.reply(claudeAnswer);
    } catch (error) {
        console.error('Error processing document:', error);
        // Refund token on error
        user.tokens += 2;
        await updateUser(userId, { tokens: user.tokens });
        await ctx.reply('Sorry, there was an error processing your document. Your tokens have been refunded.');
    }
});

// Create a webhook endpoint to handle Paystack payment callbacks
router.post('/payment/callback', async (req, res) => {
    try {
        // Verify that the request is from Paystack
        const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (hash !== req.headers['x-paystack-signature']) {
            return res.status(403).send('Invalid signature');
        }

        const event = req.body;

        // Handle successful charge event
        if (event.event === 'charge.success') {
            const reference = event.data.reference;

            // Find transaction in database
            const transaction = await Transaction.findOne({ reference });

            if (!transaction) {
                console.error('Transaction not found:', reference);
                return res.status(404).send('Transaction not found');
            }

            // Update transaction status
            transaction.status = 'success';
            transaction.completedAt = new Date();
            transaction.gatewayResponse = event.data;
            await transaction.save();

            // Get user
            const userId = transaction.userId;
            const user = await getUser(userId);

            if (!user) {
                console.error('User not found:', userId);
                return res.status(404).send('User not found');
            }

            // Add tokens to user
            const newTokens = user.tokens + transaction.tokens;
            await updateUser(userId, { tokens: newTokens });

            // Notify user via Telegram
            try {
                const telegramId = userId.substring(3); // Remove 'tg:' prefix
                await bot.telegram.sendMessage(
                    telegramId,
                    `Payment verified successfully! ✅\n\n` +
                    `${transaction.tokens} tokens have been added to your account.\n\n` +
                    `You now have ${newTokens} tokens.`
                );

                // Clear payment state if exists
                paymentStates.delete(userId);
            } catch (telegramError) {
                console.error('Error sending Telegram notification:', telegramError);
            }
        }

        res.status(200).send('Webhook received');
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).send('Error processing webhook');
    }
});

// Handle regular messages
bot.on('message', async (ctx) => {
    // Ignore commands (they're handled above)
    if (ctx.message.text && ctx.message.text.startsWith('/')) {
        return;
    }

    const userId = prefix + ctx.from.id;
    const state = paymentStates.get(userId);

    // Handle payment flow
    if (state && state.step !== 'init') {
        try {
            const user = await getUser(userId);

            if (!user) {
                return ctx.reply('Session expired. Please start again with /payments.');
            }

            // Handle email input for payment process
            if (state.step === 'email' && ctx.message.text) {
                const email = ctx.message.text.trim();

                // Simple email validation
                if (!email.includes('@') || !email.includes('.')) {
                    return ctx.reply('Please enter a valid email address.');
                }

                // Update user email
                await updateUser(userId, { email: email });

                // Show save card option for card payments
                if (state.method === 'card') {
                    // Update payment state
                    state.email = email;
                    state.step = 'save_card';
                    paymentStates.set(userId, state);

                    await ctx.reply(
                        'Would you like to save your card for future payments?',
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: 'Yes, save my card', callback_data: 'save_card_yes' },
                                        { text: 'No, don\'t save', callback_data: 'save_card_no' }
                                    ]
                                ]
                            }
                        }
                    );
                    return;
                }

                // Update payment state for bank transfer
                state.step = 'processing';
                state.email = email;
                paymentStates.set(userId, state);

                // Process bank transfer
                if (state.method === 'bank') {
                    const processingMsg = await ctx.reply('Processing your bank transfer request...');

                    // Extract numeric ID for reference generation
                    const numericUserId = user.userId.replace(/[^0-9]/g, '');

                    // Create transaction reference
                    const reference = `FLO-BANK-${Date.now()}-${numericUserId}`;

                    // Create transaction in database
                    const transaction = new Transaction({
                        userId: user.userId,
                        reference,
                        amount: state.amount,
                        tokens: state.tokens,
                        email,
                        method: 'bank_transfer',
                        status: 'pending',
                        createdAt: new Date(),
                        metadata: {
                            bankName: process.env.PAYSTACK_BANK_NAME,
                            accountName: process.env.PAYSTACK_ACCOUNT_NAME,
                            accountNumber: process.env.PAYSTACK_ACCOUNT_NUMBER
                        }
                    });

                    await transaction.save();

                    // Store reference in state
                    state.reference = reference;
                    paymentStates.set(userId, state);

                    // Send bank details
                    await ctx.reply(
                        `Please transfer ₦${state.amount} to:\n\n` +
                        `Bank: ${process.env.PAYSTACK_BANK_NAME}\n` +
                        `Account Name: ${process.env.PAYSTACK_ACCOUNT_NAME}\n` +
                        `Account Number: ${process.env.PAYSTACK_ACCOUNT_NUMBER}\n\n` +
                        `Reference: ${reference}\n\n` +
                        `Important: Use the reference above as your payment description.\n\n` +
                        `After making the transfer, send \n/verify ${reference}\n\n to confirm your payment.`
                    );
                }
            }
        } catch (error) {
            console.error('Error in payment message handler:', error);
            await ctx.reply('Sorry, something went wrong with the payment process. Please try again with /payments.');
        }
        return;
    }

    // Handle regular messages (existing code)
    try {
        let user = await getUser(userId);

        if (!user) {
            user = await addUser({
                id: userId,
                name: ctx.from.first_name,
                tokens: 25
            });
            await ctx.reply(walkThru(user.tokens));
            return;
        }

        if (user.tokens < 1) {
            return ctx.reply('You have no tokens left. Send /payments to top up.');
        }

        // Send "thinking" message
        await ctx.reply('Thinking...');

        // Update tokens before processing
        user.tokens -= 1;
        await updateUser(userId, { tokens: user.tokens });

        try {
            if (!user.convoHistory) {
                user.convoHistory = [];
            }

            user.convoHistory.push({
                role: "user",
                content: ctx.message.text
            });

            // Send prompt to Claude
            let claudeAnswer = await askClaude(user, ctx.message.text);

            // Add response to history
            user.convoHistory.push({
                role: "assistant",
                content: claudeAnswer
            });

            // Update user in database
            await updateUser(userId, { convoHistory: user.convoHistory });

            // Reply to the user
            await ctx.reply(claudeAnswer);
        } catch (error) {
            console.error('Error getting Claude response:', error);
            // Refund token on error
            user.tokens += 1;
            await updateUser(userId, { tokens: user.tokens });
            await ctx.reply('Sorry, there was an error. Your token has been refunded.');
        }
    } catch (error) {
        console.error('Error processing message:', error);
        await ctx.reply('Sorry, there was an error processing your request. Please try again.');
    }
});

// Handle card saving preference
bot.action('save_card_yes', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        const user = await getUser(userId);
        const state = paymentStates.get(userId);

        if (!user || !state) {
            return ctx.reply('Session expired. Please start again with /payments.');
        }

        // Update state with card saving preference
        state.saveCard = true;
        state.step = 'processing';
        paymentStates.set(userId, state);

        await ctx.answerCbQuery();
        await processCardPayment(ctx, user, state);
    } catch (error) {
        console.error('Error handling save card preference:', error);
        await ctx.answerCbQuery('An error occurred');
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.action('save_card_no', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        const user = await getUser(userId);
        const state = paymentStates.get(userId);

        if (!user || !state) {
            return ctx.reply('Session expired. Please start again with /payments.');
        }

        // Update state with card saving preference
        state.saveCard = false;
        state.step = 'processing';
        paymentStates.set(userId, state);

        await ctx.answerCbQuery();
        await processCardPayment(ctx, user, state);
    } catch (error) {
        console.error('Error handling save card preference:', error);
        await ctx.answerCbQuery('An error occurred');
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

// Function to process card payment
async function processCardPayment(ctx, user, state) {
    try {
        const processingMsg = await ctx.reply('Processing your card payment...');

        // Extract numeric ID for reference generation
        const numericUserId = user.userId.replace(/[^0-9]/g, '');

        // Create transaction reference
        const reference = `FLO-CARD-${Date.now()}-${numericUserId}`;

        // Create transaction in database
        const transaction = new Transaction({
            userId: user.userId,
            reference,
            amount: state.amount,
            tokens: state.tokens,
            email: state.email,
            method: 'card',
            status: 'pending',
            createdAt: new Date(),
            metadata: {
                saveCard: state.saveCard
            }
        });

        await transaction.save();

        // Initialize card payment with Paystack
        const callbackUrl = `${process.env.BOT_WEBHOOK_URL}/tg/payment/callback`;

        const paymentData = {
            email: state.email,
            amount: state.amount * 100, // Convert to kobo
            reference,
            callback_url: callbackUrl,
            metadata: {
                user_id: numericUserId, // Use numeric ID only for Paystack
                save_card: state.saveCard,
                tokens: state.tokens
            }
        };

        console.log('Initializing payment with data:', paymentData);

        // Set NODE_ENV to development for testing if needed
        if (!process.env.NODE_ENV) {
            process.env.NODE_ENV = 'development';
        }

        // In development mode, we can skip actual Paystack API call
        if (process.env.NODE_ENV === 'development' && !process.env.PAYSTACK_SECRET_KEY) {
            console.log('DEV MODE: Skipping actual Paystack API call');

            // Fake a successful response
            const mockAuthUrl = `https://checkout.paystack.com/test_${reference}`;

            // Save mock URL in transaction
            transaction.metadata.authorizationUrl = mockAuthUrl;
            await transaction.save();

            // Update state with reference
            state.reference = reference;
            paymentStates.set(user.userId, state);

            await ctx.reply(
                `Please complete your payment by clicking the link below:\n\n${mockAuthUrl}\n\n` +
                `After payment, your tokens will be added automatically. If you don't receive a confirmation within 5 minutes, send \n/verify ${reference}\n\n`
            );

            return;
        }

        // Get payment URL from Paystack
        try {
            const response = await fetch('https://api.paystack.co/transaction/initialize', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(paymentData)
            });

            const result = await response.json();

            if (result.status) {
                // Save authorization URL
                transaction.metadata.authorizationUrl = result.data.authorization_url;
                await transaction.save();

                // Update state with reference
                state.reference = reference;
                paymentStates.set(user.userId, state);

                await ctx.reply(
                    `Please complete your payment by clicking the link below:\n\n${result.data.authorization_url}\n\n` +
                    `After payment, your tokens will be added automatically. If you don't receive a confirmation within 5 minutes, send \n/verify ${reference}\n\n`
                );
            } else {
                console.error('Paystack initialization failed:', result);
                await ctx.reply(`Payment initialization failed: ${result.message}`);
            }
        } catch (error) {
            console.error('Error calling Paystack API:', error);
            await ctx.reply('Sorry, we could not connect to the payment provider. Please try again later.');
        }
    } catch (error) {
        console.error('Error processing card payment:', error);
        await ctx.reply('Sorry, something went wrong with the payment process. Please try again.');
    }
}


// Error handling
bot.catch((err, ctx) => {
    console.error('Telegraf error:', err);
    ctx.reply('An error occurred. Please try again later.');
});

// Webhook setup
export function setupWebhook(url) {
    const webhookUrl = `${url}/tg`;
    bot.telegram.setWebhook(webhookUrl)
        .then(() => {
            console.log(`Webhook set to ${webhookUrl}`);
        })
        .catch(error => {
            console.error('Error setting webhook:', error);
        });
}

// Express webhook handler for production
router.post('/', (req, res) => {
    console.log('Received webhook request from Telegram');
    bot.handleUpdate(req.body, res);
});

// Health check endpoint
router.get('/', (req, res) => {
    res.status(200).send('Telegram bot is running');
});

// Export both router and bot
export const tg = { router, bot, setupWebhook };