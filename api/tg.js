import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { connectDB } from '../db/db.js';
import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';

const router = express.Router();
import {
    addUser, getUser, updateUser, askClaude, askClaudeWithAtt, walkThru
} from '../utils/utils.js';
import { downloadTelegramFile } from '../utils/getMsgContent.js';
import { Transaction } from '../models/transactions.js';
import VerificationState from '../models/verificationState.js';
import { initializeCardPayment, initializeBankTransfer, verifyTransaction } from '../utils/paystack.js';

dotenv.config();
const bot = new Telegraf(process.env.BOT_TOKEN);
const prefix = 'tg-';

bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query;

    // Check if the query is related to verification
    if (query.toLowerCase().startsWith('verify')) {
        await ctx.answerInlineQuery([
            {
                id: '1',
                type: 'article',
                title: 'Verify Payment',
                description: 'Enter your payment reference number',
                input_message_content: {
                    message_text: 'Please enter your payment reference number to verify:',
                }
            }
        ], {
            cache_time: 0
        });
    }
});

// Command handlers
bot.command('start', async (ctx) => {
    try {
        console.log('Received /start command from', ctx.from.id);
        const userId = prefix + ctx.from.id;

        await connectDB(process.env.MONGODB_URI);
        let user = await getUser(userId);

        if (!user) {
            user = await addUser({
                id: userId,
                name: ctx.from.first_name,
                tokens: 25
            });
            await ctx.reply("Welcome to Florence*!");
        }

        // Reset conversation
        user.convoHistory = [];
        await updateUser(userId, { convoHistory: [] });
        await ctx.reply(`Hello ${ctx.from.first_name}, what do you need help with today?\n\nYou have ${user.tokens} tokens.`);
    } catch (error) {
        console.error('Error in /start command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('cancel', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        let cancelledSomething = false;

        await connectDB(process.env.MONGODB_URI);

        // Check for regular requests
        const requestState = await RequestState.findOne({
            userId: userId,
            status: 'processing'
        });

        if (requestState) {
            requestState.status = 'cancelled';
            await requestState.save();

            const user = await getUser(userId);
            if (user) {
                user.tokens += requestState.tokenCost || 1;
                await updateUser(userId, { tokens: user.tokens });
            }

            cancelledSomething = true;
        }

        // Check for media groups
        const mediaGroup = await MediaGroup.findOne({
            userId: userId,
            $or: [
                { status: 'collecting' },
                { status: 'processing' }
            ]
        });

        if (mediaGroup) {
            // Only refund tokens if we were processing (not collecting)
            if (mediaGroup.status === 'processing') {
                const user = await getUser(userId);
                if (user) {
                    user.tokens += mediaGroup.tokenCost || 2;
                    await updateUser(userId, { tokens: user.tokens });
                }
            }

            mediaGroup.status = 'cancelled';
            await mediaGroup.save();

            cancelledSomething = true;
        }

        if (cancelledSomething) {
            await ctx.reply('Request cancelled. Your tokens have been refunded if they were already deducted.');
        } else {
            await ctx.reply('No ongoing requests to cancel.');
        }
    } catch (error) {
        console.error('Error in cancel command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('about', async (ctx) => {
    await ctx.reply('Florence* is the educational assistant at your fingertips.\n\nI can help you with a variety of tasks, including:\n- Answering questions\n- Providing explanations\n- Offering study tips\n\nJust ask away!');
});

bot.command('tokens', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;

        await connectDB(process.env.MONGODB_URI);
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

bot.command('payments', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;

        await connectDB(process.env.MONGODB_URI);
        const user = await getUser(userId);

        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        // Create/update payment state in database
        await PaymentState.findOneAndUpdate(
            { userId },
            {
                step: 'init',
                amount: 1000,
                tokens: 25,
                createdAt: new Date()
            },
            { upsert: true, new: true }
        );

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

bot.command('transactions', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;

        await connectDB(process.env.MONGODB_URI);
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

bot.command('verify', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        await connectDB(process.env.MONGODB_URI);
        const user = await getUser(userId);

        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        const parts = ctx.message.text.split(' ');

        // If reference is provided with the command
        if (parts.length >= 2) {
            const reference = parts[1].trim();
            const verifyMsg = await ctx.reply('Verifying your payment...');
            console.log(`User ${userId} is verifying payment with reference: ${reference}`);

            const verificationResult = await verifyTransaction(reference);
            console.log('Verification result:', verificationResult);

            if (verificationResult.success) {
                const newTokens = user.tokens + verificationResult.tokens;
                await updateUser(userId, { tokens: newTokens });

                await ctx.reply(
                    `Payment verified successfully! ✅\n\n` +
                    `${verificationResult.tokens} tokens have been added to your account.\n\n` +
                    `You now have ${newTokens} tokens.`
                );

                // Clean up payment state
                await PaymentState.deleteOne({ userId });
            } else {
                await ctx.reply(`Payment verification failed: ${verificationResult.message}`);
            }
        }
        // If no reference provided, start the two-step verification process
        else {
            // Create or update verification state
            await VerificationState.findOneAndUpdate(
                { userId },
                { status: 'awaiting_reference', createdAt: new Date() },
                { upsert: true }
            );

            await ctx.reply(
                'Please enter the payment reference number to verify:',
                {
                    reply_markup: {
                        force_reply: true,
                        selective: true
                    }
                }
            );
        }
    } catch (error) {
        console.error('Error in verify command:', error);
        await ctx.reply('Sorry, something went wrong with payment verification. Please try again or contact support.');
    }
});

bot.command('conversations', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;

        await connectDB(process.env.MONGODB_URI);
        const user = await getUser(userId);

        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        if (!user.convos || !Array.isArray(user.convos)) {
            user.convos = [];
            await updateUser(userId, { convos: [] });
        }

        if (user.convos.length === 0) {
            return ctx.reply('You have no saved conversations yet. Start a new one by sending a message!');
        }

        const buttons = user.convos.map((convo, index) => {
            return [Markup.button.callback(convo.title || `Conversation ${index + 1}`, `convo_${index}`)];
        });

        await ctx.reply('Your saved conversations:', Markup.inlineKeyboard(buttons));
    } catch (error) {
        console.error('Error in /conversations command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('stem', async (ctx) => {
    ctx.reply("This feature is coming soon :)")
});

bot.command('research', async (ctx) => {
    ctx.reply("The research feature is coming soon :)")
});

bot.command('help', async (ctx) => {
    await ctx.reply(`Here are some commands you can use:\n\n 
/start - Start a NEW conversation thread\n 
/about - Learn more about Florence*\n 
/tokens - see how many tokens you have left\n 
/payments - Top up your tokens\n 
/conversations - View and continue previous conversations\n 
/stem - Answer math & science questions even better [coming soon]\n 
/research - Get help with your research/thesis/project [coming soon]\n 
/feedback - Send feedback to the developers\n 
/verify - Verify your payment status\n 
/cancel - Cancel an ongoing request\n
/help - Get a list of all commands`);
});

/* === Callback Handlers === */

bot.action('payment_card', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;

        await connectDB(process.env.MONGODB_URI);
        const user = await getUser(userId);
        const state = await PaymentState.findOne({ userId });

        if (!user || !state) {
            return ctx.reply('Session expired. Please start again with /payments.');
        }

        // Update payment state
        state.step = 'email';
        state.method = 'card';
        await state.save();

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

        await connectDB(process.env.MONGODB_URI);
        const user = await getUser(userId);
        const state = await PaymentState.findOne({ userId });

        if (!user || !state) {
            return ctx.reply('Session expired. Please start again with /payments.');
        }

        // Update payment state
        state.step = 'email';
        state.method = 'bank';
        await state.save();

        await ctx.answerCbQuery();
        await ctx.reply('Please enter your email address for payment receipt:');
    } catch (error) {
        console.error('Error in bank transfer handler:', error);
        await ctx.answerCbQuery('An error occurred');
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.action(/convo_(\d+)/, async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;

        await connectDB(process.env.MONGODB_URI);
        const user = await getUser(userId);

        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        const convoIndex = parseInt(ctx.match[1], 10);
        if (!user.convos || !user.convos[convoIndex]) {
            return ctx.answerCbQuery('Conversation not found');
        }

        await updateUser(userId, { convoHistory: [...user.convos[convoIndex].messages] });

        await ctx.answerCbQuery(`Loaded: ${user.convos[convoIndex].title}`);
        await ctx.reply(`Loaded conversation: "${user.convos[convoIndex].title}"\nYou can now continue where you left off.`);
    } catch (error) {
        console.error('Error handling conversation selection:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.action('save_card_yes', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;

        await connectDB(process.env.MONGODB_URI);
        const user = await getUser(userId);
        const state = await PaymentState.findOne({ userId });

        if (!user || !state) {
            return ctx.reply('Session expired. Please start again with /payments.');
        }

        // Update payment state
        state.saveCard = true;
        state.step = 'processing';
        await state.save();

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

        await connectDB(process.env.MONGODB_URI);
        const user = await getUser(userId);
        const state = await PaymentState.findOne({ userId });

        if (!user || !state) {
            return ctx.reply('Session expired. Please start again with /payments.');
        }

        // Update payment state
        state.saveCard = false;
        state.step = 'processing';
        await state.save();

        await ctx.answerCbQuery();
        await processCardPayment(ctx, user, state);
    } catch (error) {
        console.error('Error handling save card preference:', error);
        await ctx.answerCbQuery('An error occurred');
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.action(/^verify_(.+)$/, async (ctx) => {
    try {
        await connectDB(process.env.MONGODB_URI);

        const userId = prefix + ctx.from.id;
        const user = await getUser(userId);

        if (!user) {
            return ctx.answerCbQuery('Session expired. Please start the bot again with /start.', true);
        }

        const reference = ctx.match[1];

        // Answer the callback query with a loading message
        await ctx.answerCbQuery('Verifying your payment...', false);

        // Show a processing message
        const processingMsg = await ctx.reply('Verifying your payment...');

        // Verify the transaction
        const verificationResult = await verifyTransaction(reference);

        if (verificationResult.success) {
            const newTokens = user.tokens + verificationResult.tokens;
            await updateUser(userId, { tokens: newTokens });

            // Delete the processing message and send success message
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);

            await ctx.reply(
                `Payment verified successfully! ✅\n\n` +
                `${verificationResult.tokens} tokens have been added to your account.\n\n` +
                `You now have ${newTokens} tokens.`
            );

            // Clean up payment state
            await PaymentState.deleteOne({ userId });

            // Edit the original message to remove the verify button
            try {
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
            } catch (error) {
                // Ignore errors if message is too old to edit
                console.log('Could not edit original message:', error.message);
            }
        } else {
            // Delete the processing message and send failure message
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);

            await ctx.reply(`Payment verification failed: ${verificationResult.message}\n\nIf you just completed the payment, please wait a few minutes and try again.`);
        }
    } catch (error) {
        console.error('Error in verify payment button handler:', error);
        await ctx.answerCbQuery('An error occurred while verifying payment', true);
        await ctx.reply('Sorry, something went wrong with payment verification. Please try again or contact support.');
    }
});

/* === Message Handlers === */

bot.on(message('photo'), async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;

        await connectDB(process.env.MONGODB_URI);
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

        // Create request in database
        const requestState = new RequestState({
            userId: userId,
            tokenCost: 2,
            messageId: ctx.message.message_id,
            status: 'processing',
            prompt: caption,
            isMedia: true,
            mediaType: 'photo',
            mediaFileId: fileId,
            createdAt: new Date()
        });
        await requestState.save();

        const thinkingMsg = await ctx.reply('Thinking...');

        // Deduct tokens
        user.tokens -= 2;
        await updateUser(userId, { tokens: user.tokens });

        try {
            const imgBuffer = await downloadTelegramFile(bot, fileId);
            let b64img = Buffer.from(imgBuffer).toString('base64');
            const mimeType = 'image/jpeg';

            // Check if request was cancelled
            const updatedRequest = await RequestState.findById(requestState._id);
            if (!updatedRequest || updatedRequest.status !== 'processing') {
                return;
            }

            // Process with Claude
            let claudeAnswer = await askClaudeWithAtt(user, b64img, ['image', mimeType], caption);

            // Check again if cancelled
            const finalRequest = await RequestState.findById(requestState._id);
            if (!finalRequest || finalRequest.status !== 'processing') {
                return;
            }

            // Update request status
            requestState.status = 'completed';
            await requestState.save();

            // Send reply
            await ctx.reply(claudeAnswer);
        } catch (error) {
            console.error('Error processing image:', error);

            // Refund tokens on error
            user.tokens += 2;
            await updateUser(userId, { tokens: user.tokens });

            // Update request status
            requestState.status = 'failed';
            requestState.error = error.message;
            await requestState.save();

            await ctx.reply('Sorry, there was an error processing your image. Your tokens have been refunded.');
        }
    } catch (error) {
        console.error('Error handling photo:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.on(message('document'), async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;

        await connectDB(process.env.MONGODB_URI);
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

        // Create request in database
        const requestState = new RequestState({
            userId: userId,
            tokenCost: 2,
            messageId: ctx.message.message_id,
            status: 'processing',
            prompt: caption,
            isMedia: true,
            mediaType: 'document',
            mediaFileId: fileId,
            mediaMimeType: mimeType,
            mediaFileName: fileName,
            createdAt: new Date()
        });
        await requestState.save();

        const thinkingMsg = await ctx.reply('Thinking...');

        // Deduct tokens
        user.tokens -= 2;
        await updateUser(userId, { tokens: user.tokens });

        try {
            const fileBuffer = await downloadTelegramFile(bot, fileId);

            // Check if request was cancelled
            const updatedRequest = await RequestState.findById(requestState._id);
            if (!updatedRequest || updatedRequest.status !== 'processing') {
                return;
            }

            // Process with Claude
            let claudeAnswer = await askClaudeWithAtt(
                user,
                fileBuffer.toString('base64'),
                ['document', mimeType],
                caption
            );

            // Check again if cancelled
            const finalRequest = await RequestState.findById(requestState._id);
            if (!finalRequest || finalRequest.status !== 'processing') {
                return;
            }

            // Update request status
            requestState.status = 'completed';
            await requestState.save();

            // Send reply
            await ctx.reply(claudeAnswer);
        } catch (error) {
            console.error('Error processing document:', error);

            // Refund tokens on error
            user.tokens += 2;
            await updateUser(userId, { tokens: user.tokens });

            // Update request status
            requestState.status = 'failed';
            requestState.error = error.message;
            await requestState.save();

            await ctx.reply('Sorry, there was an error processing your document. Your tokens have been refunded.');
        }
    } catch (error) {
        console.error('Error handling document:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.on('message', async (ctx) => {
    // Skip commands
    if (ctx.message.text && ctx.message.text.startsWith('/')) {
        return;
    }

    try {
        const userId = prefix + ctx.from.id;

        await connectDB(process.env.MONGODB_URI);

        // Check if this is a payment flow message
        const paymentState = await PaymentState.findOne({ userId });

        if (paymentState && paymentState.step !== 'init') {
            await handlePaymentMessage(ctx, userId, paymentState);
            return;
        }

        if (ctx.message.text && !ctx.message.text.startsWith('/')) {
            // Check if user is in verification state
            const verificationState = await VerificationState.findOne({ userId });

            if (verificationState && verificationState.status === 'awaiting_reference') {
                // Process the reference number
                const reference = ctx.message.text.trim();

                // Delete the verification state
                await VerificationState.deleteOne({ userId });

                const verifyMsg = await ctx.reply('Verifying your payment...');
                console.log(`User ${userId} is verifying payment with reference: ${reference}`);

                const verificationResult = await verifyTransaction(reference);
                console.log('Verification result:', verificationResult);

                if (verificationResult.success) {
                    const newTokens = userId.tokens + verificationResult.tokens;
                    await updateUser(userId, { tokens: newTokens });

                    await ctx.reply(
                        `Payment verified successfully! ✅\n\n` +
                        `${verificationResult.tokens} tokens have been added to your account.\n\n` +
                        `You now have ${newTokens} tokens.`
                    );

                    // Clean up payment state
                    await PaymentState.deleteOne({ userId });
                } else {
                    await ctx.reply(`Payment verification failed: ${verificationResult.message}`);
                }

                return; // Exit handler since we've handled the verification
            }
        }

        // Handle regular message
        await handleRegularMessage(ctx, userId);
    } catch (error) {
        console.error('Error in message handler:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

/* === Helper Functions === */

async function handlePaymentMessage(ctx, userId, state) {
    try {
        const user = await getUser(userId);

        if (!user) {
            return ctx.reply('Session expired. Please start again with /payments.');
        }

        if (state.step === 'email' && ctx.message.text) {
            const email = ctx.message.text.trim();

            if (!email.includes('@') || !email.includes('.')) {
                return ctx.reply('Please enter a valid email address.');
            }

            await updateUser(userId, { email: email });

            if (state.method === 'card') {
                state.email = email;
                state.step = 'save_card';
                await state.save();

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

            if (state.method === 'bank') {
                state.step = 'processing';
                state.email = email;
                await state.save();

                const callbackUrl = `${process.env.BOT_WEBHOOK_URL}/tg/payment/callback`;

                const transferResult = await initializeBankTransfer(
                    {
                        userId: user.userId,
                        email: email
                    },
                    state.amount,
                    callbackUrl
                );

                if (transferResult.success) {
                    state.reference = transferResult.reference;
                    await state.save();

                    // First message with payment link and button
                    await ctx.reply(
                        `Please complete your payment by clicking the link below:\n\n${transferResult.authorizationUrl}\n\n` +
                        `After payment, your tokens will be added automatically. If you don't receive a confirmation within 5 minutes, click the button below:`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔄 Verify Payment', callback_data: `verify_${transferResult.reference}` }]
                                ]
                            }
                        }
                    );

                    // Second message with just the reference for easy copying
                    await ctx.reply(
                        `Reference (tap to copy):\n\`${transferResult.reference}\``,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    console.error('Payment initialization failed:', transferResult.message);
                    await ctx.reply(`Payment initialization failed: ${transferResult.message}`);
                }
            }
        }
    } catch (error) {
        console.error('Error in handlePaymentMessage:', error);
        throw error;
    }
}

async function handleRegularMessage(ctx, userId) {
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

        // Create request in database
        const requestState = new RequestState({
            userId: userId,
            tokenCost: 1,
            messageId: ctx.message.message_id,
            status: 'processing',
            prompt: ctx.message.text,
            createdAt: new Date()
        });
        await requestState.save();

        const thinkingMsg = await ctx.reply('Thinking...');

        // Deduct tokens
        user.tokens -= 1;
        await updateUser(userId, { tokens: user.tokens });

        try {
            // Initialize convo history if needed
            if (!user.convoHistory) {
                user.convoHistory = [];
            }

            // Add user message to convo
            user.convoHistory.push({
                role: "user",
                content: ctx.message.text
            });

            // Check if request was cancelled
            const updatedRequest = await RequestState.findById(requestState._id);
            if (!updatedRequest || updatedRequest.status !== 'processing') {
                return;
            }

            // Get Claude response
            let claudeAnswer = await askClaude(user, ctx.message.text);

            // Check again if cancelled
            const finalRequest = await RequestState.findById(requestState._id);
            if (!finalRequest || finalRequest.status !== 'processing') {
                return;
            }

            // Add Claude's response to conversation
            user.convoHistory.push({
                role: "assistant",
                content: claudeAnswer
            });

            // Update user in database
            await updateUser(userId, { convoHistory: user.convoHistory });

            // Update request status
            requestState.status = 'completed';
            await requestState.save();

            // Send reply
            await ctx.reply(claudeAnswer);
        } catch (error) {
            console.error('Error in message processing:', error);

            // Refund tokens on error
            user.tokens += 1;
            await updateUser(userId, { tokens: user.tokens });

            // Update request status
            requestState.status = 'failed';
            requestState.error = error.message;
            await requestState.save();

            await ctx.reply('Sorry, there was an error. Your token has been refunded.');
        }
    } catch (error) {
        console.error('Error in handleRegularMessage:', error);
        throw error;
    }
}

async function processCardPayment(ctx, user, state) {
    try {
        const processingMsg = await ctx.reply('Processing your card payment...');
        const callbackUrl = `${process.env.BOT_WEBHOOK_URL}/tg/payment/callback`;

        const paymentResult = await initializeCardPayment(
            {
                userId: user.userId,
                email: state.email,
                saveCard: state.saveCard
            },
            state.amount,
            callbackUrl
        );

        if (paymentResult.success) {
            state.reference = paymentResult.reference;
            await state.save();

            // First message with payment link and button
            await ctx.reply(
                `Please complete your payment by clicking the link below:\n\n${paymentResult.authorizationUrl}\n\n` +
                `After payment, your tokens will be added automatically. If you don't receive a confirmation within 5 minutes, click the button below:`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 Verify Payment', callback_data: `verify_${paymentResult.reference}` }]
                        ]
                    }
                }
            );

            // Second message with just the reference for easy copying
            await ctx.reply(
                `Reference (tap to copy):\n\`${paymentResult.reference}\``,
                { parse_mode: 'Markdown' }
            );
        } else {
            console.error('Payment initialization failed:', paymentResult.message);
            await ctx.reply(`Payment initialization failed: ${paymentResult.message}`);
        }
    } catch (error) {
        console.error('Error processing card payment:', error);
        await ctx.reply('Sorry, something went wrong with the payment process. Please try again.');
    }
}

/* === API Endpoints === */

router.post('/payment/callback', async (req, res) => {
    try {
        await connectDB(process.env.MONGODB_URI);

        const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (hash !== req.headers['x-paystack-signature']) {
            return res.status(403).send('Invalid signature');
        }

        const event = req.body;

        if (event.event === 'charge.success') {
            const reference = event.data.reference;
            const transaction = await Transaction.findOne({ reference });

            if (!transaction) {
                console.error('Transaction not found:', reference);
                return res.status(404).send('Transaction not found');
            }

            transaction.status = 'success';
            transaction.completedAt = new Date();
            transaction.gatewayResponse = event.data;
            await transaction.save();

            const userId = transaction.userId;
            const user = await getUser(userId);

            if (!user) {
                console.error('User not found:', userId);
                return res.status(404).send('User not found');
            }

            const newTokens = user.tokens + transaction.tokens;
            await updateUser(userId, { tokens: newTokens });

            try {
                const telegramId = userId.substring(3);
                await bot.telegram.sendMessage(
                    telegramId,
                    `Payment verified successfully! ✅\n\n` +
                    `${transaction.tokens} tokens have been added to your account.\n\n` +
                    `You now have ${newTokens} tokens.`
                );

                // Clean up payment state
                await PaymentState.deleteOne({ userId });
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

/* === Error Handling === */

bot.catch((err, ctx) => {
    console.error('Telegraf error:', err);
    ctx.reply('An error occurred. Please try again later.');
});

/* === Webhook Setup === */

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

/* === Serverless Handler === */

export default async function handler(req, res) {
    try {
        // Connect to database
        await connectDB(process.env.MONGODB_URI);

        // Only allow POST requests for the webhook
        if (req.method !== 'POST') {
            if (req.method === 'GET') {
                return res.status(200).send('Telegram webhook is active');
            }
            return res.status(405).send('Method not allowed');
        }

        // Process the update from Telegram
        await bot.handleUpdate(req.body);

        // Always respond with 200 OK to Telegram quickly
        res.status(200).send('OK');
    } catch (error) {
        console.error('Error handling webhook:', error);
        res.status(500).send('Internal Server Error');
    }
}

/* === Import the missing models === */

// Define RequestState and MediaGroup models
import mongoose from 'mongoose';

// If you haven't created these models yet, add them here
const requestStateSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    tokenCost: {
        type: Number,
        default: 1
    },
    messageId: {
        type: Number
    },
    status: {
        type: String,
        enum: ['processing', 'completed', 'cancelled', 'failed'],
        default: 'processing'
    },
    prompt: {
        type: String
    },
    isMedia: {
        type: Boolean,
        default: false
    },
    mediaType: {
        type: String,
        enum: ['photo', 'document', null],
        default: null
    },
    mediaFileId: {
        type: String
    },
    mediaMimeType: {
        type: String
    },
    mediaFileName: {
        type: String
    },
    error: {
        type: String
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 86400 // Auto-delete after 24 hours
    }
});

// Payment state for tracking the payment flow
const paymentStateSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    step: {
        type: String,
        enum: ['init', 'email', 'save_card', 'processing', 'completed', 'cancelled'],
        default: 'init'
    },
    method: {
        type: String,
        enum: ['card', 'bank', null],
        default: null
    },
    amount: {
        type: Number,
        default: 1000
    },
    tokens: {
        type: Number,
        default: 25
    },
    email: {
        type: String
    },
    saveCard: {
        type: Boolean,
        default: false
    },
    reference: {
        type: String
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 3600 // Auto-delete after 1 hour
    }
});

// Media group for handling multiple images
const mediaGroupSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: ['collecting', 'processing', 'completed', 'cancelled', 'failed'],
        default: 'collecting'
    },
    caption: {
        type: String,
        default: ''
    },
    mediaItems: [{
        fileId: String,
        type: {
            type: String,
            enum: ['photo', 'document']
        }
    }],
    tokenCost: {
        type: Number,
        default: 2
    },
    result: {
        type: String
    },
    error: {
        type: String
    },
    expiresAt: {
        type: Date
    },
    lastActivity: {
        type: Date,
        default: Date.now
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 86400 // Auto-delete after 24 hours
    }
});

// Create models
const RequestState = mongoose.models.RequestState || mongoose.model('RequestState', requestStateSchema);
const PaymentState = mongoose.models.PaymentState || mongoose.model('PaymentState', paymentStateSchema);
const MediaGroup = mongoose.models.MediaGroup || mongoose.model('MediaGroup', mediaGroupSchema);

// Export for Express.js usage
router.post('/', (req, res) => {
    console.log('Received webhook request from Telegram');
    bot.handleUpdate(req.body, res);
});

router.get('/', (req, res) => {
    res.status(200).send('Telegram bot is running');
});

export const tg = { router, bot, setupWebhook };