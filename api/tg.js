import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { ensureConnection } from '../db/connection.js';
import express from 'express';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import crypto from 'crypto';

const router = express.Router();
import {
    addUser, getUser, updateUser, askGpt, askGptWithAtt, walkThru
} from '../utils/utils.js';
import { downloadTelegramFile } from '../utils/getMsgContent.js';
import { Transaction } from '../models/transactions.js';
import VerificationState from '../models/verificationState.js';
import { initializeCardPayment, initializeBankTransfer, verifyTransaction } from '../utils/paystack.js';
import { updateUserStreak, checkStreakReward, getUserStreakInfo } from '../utils/streakManager.js';
import { RequestState } from '../models/serverless.js';

dotenv.config();
const bot = new Telegraf(process.env.BOT_TOKEN);
const prefix = 'tg-';

/* === MarkdownV2 Formatter === */
function formatForMarkdownV2(text) {
    if (!text) return text;

    let result = text;

    result = result.replace(/<pre>(.*?)<\/pre>/gs, (match, content) => {
        return `\`\`\`\n${content}\n\`\`\``;
    });

    result = result.replace(/<code>(.*?)<\/code>/g, (match, content) => {
        return `\`${content}\``;
    });

    result = result.replace(/<b>(.*?)<\/b>/g, (match, content) => {
        return `*${content}*`;
    });

    result = result.replace(/<i>(.*?)<\/i>/g, (match, content) => {
        return `_${content}_`;
    });

    result = result.replace(/<[^>]*>/g, '');

    // Protect code blocks and inline code from escaping
    const protectedParts = [];
    let partIndex = 0;

    result = result.replace(/```[\s\S]*?```|`[^`]*`/g, (match) => {
        const placeholder = `__PROTECTED_${partIndex}__`;
        protectedParts[partIndex] = match;
        partIndex++;
        return placeholder;
    });

    // Escape all special MarkdownV2 characters
    result = result.replace(/([_*\[\]()~>#+=|{}.!-])/g, '\\$1');

    // Restore protected parts
    protectedParts.forEach((part, index) => {
        result = result.replace(`__PROTECTED_${index}__`, part);
    });

    // Fix formatting markers - unescape them so they work as formatting
    result = result.replace(/\\\*/g, '*');
    result = result.replace(/\\_/g, '_');
    result = result.replace(/\\`/g, '`');

    return result;
}

function escapeMarkdownV2(text) {
    let result = '';
    let inCodeBlock = false;
    let inInlineCode = false;
    let inBold = false;
    let inItalic = false;
    let i = 0;

    while (i < text.length) {
        const char = text[i];
        const nextChar = text[i + 1];
        const prevChar = text[i - 1];

        if (char === '`' && nextChar === '`' && text[i + 2] === '`' && !inInlineCode) {
            inCodeBlock = !inCodeBlock;
            result += '```';
            i += 3;
            continue;
        }

        if (char === '`' && !inCodeBlock && prevChar !== '\\') {
            inInlineCode = !inInlineCode;
            result += char;
            i++;
            continue;
        }

        if (inCodeBlock || inInlineCode) {
            result += char;
            i++;
            continue;
        }

        if (char === '*' && prevChar !== '\\') {
            inBold = !inBold;
            result += char;
            i++;
            continue;
        }

        if (char === '_' && prevChar !== '\\') {
            inItalic = !inItalic;
            result += char;
            i++;
            continue;
        }

        const specialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];

        if (specialChars.includes(char) && !inBold && !inItalic) {
            result += '\\' + char;
        } else {
            result += char;
        }

        i++;
    }

    return result;
 }

bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query;

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
        const userId = prefix + ctx.from.id;
        await ensureConnection();
        let user = await getUser(userId);
        let isNewUser = false;

        if (!user) {
            isNewUser = true;
            user = await addUser({
                id: userId,
                name: ctx.from.first_name,
                tokens: 10
            });
        }

        // Save existing conversation if it has any messages
        if (user.convoHistory && user.convoHistory.length > 0) {
            // Create a title for the conversation
            let title = "Conversation";

            // Find the first user message in conversation history
            const firstUserMessage = user.convoHistory.find(msg => msg.role === "user");

            if (firstUserMessage) {
                // Check if the content is a string before using substring
                if (typeof firstUserMessage.content === 'string') {
                    title = firstUserMessage.content.substring(0, 20) +
                        (firstUserMessage.content.length > 20 ? "..." : "");
                } else if (Array.isArray(firstUserMessage.content) && firstUserMessage.content.length > 0) {
                    // If it's an array (for messages with attachments), use a default title
                    title = "Conversation with attachment";
                }
            }

            // Initialize convos array if it doesn't exist
            if (!user.convos) user.convos = [];

            // Add current conversation to saved conversations
            user.convos.push({
                title: title,
                messages: [...user.convoHistory]
            });

            // Save the updated conversations list
            await updateUser(userId, { convos: user.convos });
        }

        // Now safe to reset the conversation
        user.convoHistory = [];
        await updateUser(userId, { convoHistory: [] });

        // For new users, show the walkthrough
        if (isNewUser) {
            await ctx.reply(walkThru(user.tokens));
            await ctx.reply(`Please be aware that Florence* is currently unable to process document uploads due to an internal error. We are working to resolve this issue as soon as possible. Thank you for your patience!`)
        } else {
            await ctx.reply(`Hello ${ctx.from.first_name}, what do you need help with today?\n\nYou have ${user.tokens} tokens.`);
        }
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

        await ensureConnection();
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

        await ensureConnection();
        const user = await getUser(userId);

        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        // Create/update payment state in database
        const paymentState = await PaymentState.findOneAndUpdate(
            { userId },
            {
                step: 'init',
                amount: 1000,
                tokens: 10,
                createdAt: new Date()
            },
            { upsert: true, new: true }
        );

        // Check if user already has an email saved
        if (user.email) {
            // Skip email collection step and move directly to payment
            return processPayment(ctx, user, paymentState);
        } else {
            // Request email from user
            paymentState.step = 'email';
            await paymentState.save();

            return ctx.reply(
                'Please enter your email address for payment receipt (we only need this once):',
                {
                    reply_markup: {
                        force_reply: true,
                        selective: true
                    }
                }
            );
        }
    } catch (error) {
        console.error('Error in /payments command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('streak', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        const streakInfo = await getUserStreakInfo(userId);

        if (!streakInfo) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        const firstName = streakInfo.name.split(' ')[0];
        const message = `Hi ${firstName}, you have a streak of ${streakInfo.streak} ${streakInfo.streak === 1 ? 'day' : 'days'}. Keep learning with Florence*!`;

        await ctx.reply(message);
    } catch (error) {
        console.error('Error in /streak command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('transactions', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;

        await ensureConnection();
        const user = await getUser(userId);

        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        // Fetch all transactions for this user, sorted by date (newest first)
        const transactions = await Transaction.find({ userId }).sort({ createdAt: -1 });

        if (!transactions || transactions.length === 0) {
            return ctx.reply('You haven\'t made any transactions yet.');
        }

        let message = 'Transaction History with Florence*\n\n';

        transactions.forEach((tx) => {
            // Format the date nicely
            const date = tx.createdAt.toLocaleDateString('en-GB', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            });

            const time = tx.createdAt.toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit'
            });

            // Add transaction details to message
            message += `• ${date} ${time} | ${tx.reference} | ₦${tx.amount} | +${tx.tokens} tokens`;

            // Add status for non-successful transactions
            if (tx.status !== 'success') {
                message += ` (${tx.status})`;
            }

            message += '\n';
        });

        // If there are many transactions, warn the user
        if (transactions.length > 20) {
            message = `You have ${transactions.length} transactions. Here's your complete history:\n\n` + message;
        }

        await ctx.reply(message);
    } catch (error) {
        console.error('Error in /transactions command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('verify', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        await ensureConnection();
        const user = await getUser(userId);

        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        const parts = ctx.message.text.split(' ');

        // Only allow /verify with reference - no two-step process
        if (parts.length < 2) {
            return ctx.reply('Please provide a reference number. Usage: /verify [reference]');
        }

        const reference = parts.slice(1).join(' ').trim();
        const verifyMsg = await ctx.reply('Verifying your payment...');

        await performVerification(ctx, user, reference, verifyMsg);

    } catch (error) {
        console.error('Error in verify command:', error);
        await ctx.reply('Sorry, something went wrong with payment verification. Please try again or contact support.');
    }
});

bot.command('conversations', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;

        await ensureConnection();
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

bot.command('feedback', async (ctx) => {
    ctx.reply(`Enjoying Florence*?\n\nEven if you absolutely hate it 😔, please let us know:\n\nhttps://forms.gle/SwhApkszXZJGcRyP7\n\nYour feedback is greatly appreciated and helps us improve Florence*. Thank you 🩵`)
});

bot.command('help', async (ctx) => {
    await ctx.reply(`Here are some commands you can use:\n\n 
/start - Start a NEW conversation thread\n 
/about - Learn more about Florence*\n 
/tokens - see how many tokens you have left\n 
/payments - Top up your tokens\n 
/conversations - View and continue previous conversations\n
/transactions - View your transaction history\n
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

        await ensureConnection();
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

        await ensureConnection();
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

        await ensureConnection();
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

bot.action(/^verify_(.+)$/, async (ctx) => {
    try {
        await ensureConnection();

        const userId = prefix + ctx.from.id;
        const user = await getUser(userId);

        if (!user) {
            return ctx.answerCbQuery('Session expired. Please start the bot again with /start.', true);
        }

        const reference = ctx.match[1];

        // Answer the callback query
        await ctx.answerCbQuery('Verifying your payment...', false);

        // Show a processing message
        const processingMsg = await ctx.reply('Verifying your payment...');

        const result = await performVerification(ctx, user, reference, processingMsg);

        // If verification was successful, remove the verify button
        if (result && result.success) {
            try {
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
            } catch (editError) {
                console.log('Could not edit original message:', editError.message);
            }
        }

    } catch (error) {
        console.error('Error in verify payment button handler:', error);
        await ctx.answerCbQuery('An error occurred while verifying payment', true);
        await ctx.reply('Sorry, something went wrong with payment verification. Please try again or contact support.');
    }
});

// Cancel request handler
bot.action(/^cancel_(.+)$/, async (ctx) => {
    try {
        const requestId = ctx.match[1];
        const userId = prefix + ctx.from.id;

        await ensureConnection();

        // Find the request
        const request = await RequestState.findById(requestId);

        if (!request) {
            await ctx.answerCbQuery('Request not found or already completed.', true);
            return;
        }

        if (request.userId !== userId) {
            await ctx.answerCbQuery('This is not your request.', true);
            return;
        }

        if (request.status !== 'processing') {
            await ctx.answerCbQuery('This request is already completed or cancelled.', true);
            return;
        }

        // Mark as cancelled
        await request.updateOne({ status: 'cancelled' });

        // Refund tokens
        const user = await getUser(userId);
        if (user) {
            const refundAmount = request.tokenCost || 1;
            await updateUser(userId, { tokens: user.tokens + refundAmount });
            console.log(`💰 Refunded ${refundAmount} token(s) to user for cancellation`);
        }

        // Answer callback and delete thinking message
        await ctx.answerCbQuery('Request cancelled');

        try {
            await ctx.deleteMessage();
        } catch (deleteError) {
            console.log('Could not delete thinking message:', deleteError.message);
        }

        // Send cancellation confirmation
        await ctx.reply('You cancelled the prompt. You can try again.');

    } catch (error) {
        console.error('Error handling cancel request:', error);
        await ctx.answerCbQuery('An error occurred while cancelling', true);
    }
});

/* === Message Handlers === */

bot.on(message('photo'), async (ctx) => {
    const userId = prefix + ctx.from.id;
    const messageId = ctx.message.message_id;

    // Check for duplicates
    const existingRequest = await RequestState.findOne({ userId, messageId });
    if (existingRequest) return;

    let user = await getUser(userId);
    if (!user) {
        user = await addUser({
            id: userId,
            name: ctx.from.first_name,
            tokens: 10
        });
        await ctx.reply(walkThru(user.tokens));
        return;
    }

    if (user.tokens < 2) {
        return ctx.reply('You don\'t have enough tokens for an image upload. Send /payments to top up.');
    }

    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const caption = ctx.message.caption || "Assess the following image.";

    const requestState = new RequestState({
        userId,
        tokenCost: 2,
        messageId,
        status: 'processing',
        prompt: caption,
        isMedia: true,
        mediaType: 'photo',
        mediaFileId: fileId,
        createdAt: new Date()
    });

    // CHANGE: Add cancel button to thinking message
    const thinkingMsg = await ctx.reply('Thinking...', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '❌ Cancel', callback_data: `cancel_${requestState._id}` }]
            ]
        }
    });

    try {
        // Parallel operations
        await Promise.all([
            requestState.save(),
            updateUser(userId, { tokens: user.tokens - 2 }),
            updateUserStreak(userId)
        ]);

        // Download and process
        const imgBuffer = await downloadTelegramFile(bot, fileId);
        const b64img = Buffer.from(imgBuffer).toString('base64');

        // Check cancellation
        const currentRequest = await RequestState.findById(requestState._id);
        if (!currentRequest || currentRequest.status !== 'processing') return;

        const gptAnswer = await askGptWithAtt(user, b64img, ['image', 'image/jpeg'], caption);

        // Final check and respond
        const finalRequest = await RequestState.findById(requestState._id);
        if (!finalRequest || finalRequest.status !== 'processing') return;

        // Get fresh user data and store image in conversation history
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
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: "image/jpeg",
                            data: b64img
                        }
                    }
                ]
            },
            {
                role: "assistant",
                content: gptAnswer
            }
        ];

        await Promise.all([
            updateUser(userId, { convoHistory: newConvoHistory }),
            requestState.updateOne({ status: 'completed' }),
            ctx.deleteMessage(thinkingMsg.message_id).catch(() => { }),
            sendLongMessage(ctx, gptAnswer, { parse_mode: 'HTML' })
                .then(() => console.log('📤 Image response sent to user'))
        ]);
    } catch (error) {
        console.error('❌ Error processing photo:', error);

        try {
            const currentUser = await getUser(userId);
            if (currentUser) {
                await updateUser(userId, { tokens: currentUser.tokens + 2 }); // Refund 2 tokens
                console.log('💰 Refunded 2 tokens to user');
            }
        } catch (refundError) {
            console.error('❌ Error refunding tokens:', refundError);
        }

        await Promise.all([
            requestState.updateOne({ status: 'failed', error: error.message }),
            ctx.deleteMessage(thinkingMsg.message_id).catch(() => { }),
            ctx.reply('Sorry, there was an error processing your image. Your tokens have been refunded.')
        ]);
    }
});

bot.on(message('document'), async (ctx) => {
    console.log('📄 Document upload received:', {
        userId: prefix + ctx.from.id,
        fileName: ctx.message.document.file_name,
        mimeType: ctx.message.document.mime_type,
        fileSize: ctx.message.document.file_size
    });

    const userId = prefix + ctx.from.id;
    const messageId = ctx.message.message_id;

    const existingRequest = await RequestState.findOne({ userId, messageId });
    if (existingRequest) return;

    let user = await getUser(userId);
    if (!user) {
        user = await addUser({
            id: userId,
            name: ctx.from.first_name,
            tokens: 10
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

    // Validate file type
    if (!['application/pdf'].includes(mimeType) && !fileName.toLowerCase().endsWith('.pdf')) {
        return ctx.reply('Sorry, I can only process PDF documents. Please convert your document to PDF format and try again.');
    }

    const requestState = new RequestState({
        userId,
        tokenCost: 2,
        messageId,
        status: 'processing',
        prompt: caption,
        isMedia: true,
        mediaType: 'document',
        mediaFileId: fileId,
        mediaMimeType: mimeType,
        mediaFileName: fileName,
        createdAt: new Date()
    });

    const thinkingMsg = await ctx.reply('Thinking...', {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Cancel', callback_data: `cancel_${requestState._id}` }]
            ]
        }
    });

    try {
        await Promise.all([
            requestState.save(),
            updateUser(userId, { tokens: user.tokens - 2 }),
            updateUserStreak(userId)
        ]);

        console.log('📥 Downloading document...');
        const fileBuffer = await downloadTelegramFile(bot, fileId);
        console.log(`📄 Document downloaded: ${fileBuffer.length} bytes`);

        const currentRequest = await RequestState.findById(requestState._id);
        if (!currentRequest || currentRequest.status !== 'processing') return;

        console.log('📄 Sending document to GPT...');

        const gptAnswer = await askGptWithAtt(
            user,
            fileBuffer.toString('base64'),
            ['document', 'application/pdf'],
            caption
        );
        console.log('✅ GPT response received for document');

        const finalRequest = await RequestState.findById(requestState._id);
        if (!finalRequest || finalRequest.status !== 'processing') return;

        // Get fresh user data and store document in conversation history (if under 50MB)
        const freshUser = await getUser(userId);
        const fileSizeInMB = fileBuffer.length / (1024 * 1024);

        let newConvoHistory;
        if (fileSizeInMB < 50) {
            // Store document in conversation history
            newConvoHistory = [
                ...(freshUser.convoHistory || []),
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: caption
                        },
                        {
                            type: "document",
                            source: {
                                type: "base64",
                                media_type: mimeType,
                                data: fileBuffer.toString('base64')
                            }
                        }
                    ]
                },
                {
                    role: "assistant",
                    content: gptAnswer
                }
            ];
            console.log(`📚 Document stored in conversation history (${fileSizeInMB.toFixed(2)}MB)`);
        } else {
            // Just store text reference for large files
            newConvoHistory = [
                ...(freshUser.convoHistory || []),
                {
                    role: "user",
                    content: `[Large Document: ${fileName} - ${fileSizeInMB.toFixed(2)}MB] ${caption}`
                },
                {
                    role: "assistant",
                    content: gptAnswer
                }
            ];
            console.log(`📚 Large document reference stored (${fileSizeInMB.toFixed(2)}MB)`);
        }

        await Promise.all([
            updateUser(userId, { convoHistory: newConvoHistory }),
            requestState.updateOne({ status: 'completed' }),
            ctx.deleteMessage(thinkingMsg.message_id).catch(() => { }),
            sendLongMessage(ctx, gptAnswer, { parse_mode: 'HTML' }).then(() => console.log('📤 Document response sent to user'))
        ]);

    } catch (error) {
        console.error('❌ Error processing document:', error);

        // Always refund tokens on any error
        try {
            const currentUser = await getUser(userId);
            if (currentUser) {
                await updateUser(userId, { tokens: currentUser.tokens + 2 }); // Refund 2 tokens
                console.log('💰 Refunded 2 tokens to user');
            }
        } catch (refundError) {
            console.error('❌ Error refunding tokens:', refundError);
        }

        // Determine error message based on error type
        let errorMessage;
        const errorString = error.message.toLowerCase();

        if (errorString.includes('timeout') || errorString.includes('timed out')) {
            errorMessage = 'Sorry, the request timed out while processing your document. Please try uploading it again or use a smaller file. Your tokens have been refunded.';
        } else if (errorString.includes('fetch failed') || errorString.includes('download failed')) {
            errorMessage = 'Sorry, there was a problem downloading your document. Please try uploading it again. Your tokens have been refunded.';
        } else if (errorString.includes('econnreset') || errorString.includes('connection')) {
            errorMessage = 'Sorry, there was a connection error. Please try uploading your document again. Your tokens have been refunded.';
        } else {
            errorMessage = 'Sorry, there was an error processing your document. Your tokens have been refunded.';
        }

        // Update request state and send error message
        await Promise.all([
            requestState.updateOne({ status: 'failed', error: error.message }),
            ctx.deleteMessage(thinkingMsg.message_id).catch(() => { }),
            ctx.reply(errorMessage)
        ]);
    }
});

bot.on('message', async (ctx) => {
    if (ctx.message.text?.startsWith('/')) return;

    try {
        const userId = prefix + ctx.from.id;
        const messageId = ctx.message.message_id;

        await ensureConnection();

        // Add this improved check for duplicate processing
        const existingRequest = await RequestState.findOne({
            userId,
            messageId
        });

        if (existingRequest) {
            console.log(`Message ${messageId} already being processed or processed`);
            return;
        }

        // Check if this is a payment flow message
        const paymentState = await PaymentState.findOne({ userId });

        if (paymentState && paymentState.step !== 'init') {
            await handlePaymentMessage(ctx, userId, paymentState);
            return;
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

            // Save email to user profile - NO API CALL, just database update
            await updateUser(userId, { email: email });

            // Update payment state
            state.email = email;
            state.step = 'processing';
            await state.save();

            // Process the payment
            return processPayment(ctx, user, state);
        }
    } catch (error) {
        console.error('Error in handlePaymentMessage:', error);
        await ctx.reply('An error occurred with the payment process. Please try again or contact support.');
        throw error;
    }
}

async function processPayment(ctx, user, state) {
    try {
        const processingMsg = await ctx.reply('Setting up your payment...');
        const callbackUrl = `${process.env.BOT_WEBHOOK_URL}/tg/payment/callback`;

        // Initialize the payment with Paystack
        const paymentResult = await initializeCardPayment(
            {
                userId: user.userId,
                email: state.email || user.email,
            },
            state.amount,
            callbackUrl
        );

        if (paymentResult.success) {
            state.reference = paymentResult.reference;
            await state.save();

            // First message with payment link and button
            await ctx.reply(
                `Please complete your payment of ₦${state.amount} for ${state.tokens} tokens by clicking the link below:\n\n${paymentResult.authorizationUrl}\n\n` +
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
        console.error('Error processing payment:', error);
        await ctx.reply('Sorry, something went wrong with the payment process. Please try again.');
    }
}

async function performVerification(ctx, user, reference, processingMsg) {
    try {
        console.log(`User ${user.userId} is verifying payment with reference: ${reference}`);

        // Clean the reference
        const cleanReference = reference.replace(/[^a-zA-Z0-9-]/g, '');

        // Check if this reference has already been verified
        const existingVerification = await VerificationState.findOne({
            userId: user.userId,
            reference: cleanReference,
            status: 'verified'
        });

        if (existingVerification) {
            // Delete processing message if it exists
            if (processingMsg && processingMsg.message_id) {
                try {
                    await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
                } catch (e) { }
            }

            await ctx.reply(
                `⚠️ Already Verified\n\n` +
                `This payment reference has already been used.\n` +
                `The tokens were previously added to your account.\n\n` +
                `Current balance: ${user.tokens} tokens`
            );
            return { success: false };
        }

        // Verify with Paystack
        const verificationResult = await verifyTransaction(cleanReference);
        console.log('Verification result:', verificationResult);

        // Delete processing message if it exists
        if (processingMsg && processingMsg.message_id) {
            try {
                await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
            } catch (e) { }
        }

        if (verificationResult.success) {
            // Add tokens to user
            const newTokens = user.tokens + verificationResult.tokens;
            await updateUser(user.userId, { tokens: newTokens });

            // Mark as verified in VerificationState
            await VerificationState.create({
                userId: user.userId,
                reference: cleanReference,
                status: 'verified',
                tokens: verificationResult.tokens,
                verifiedAt: new Date()
            });

            await ctx.reply(
                `✅ Payment Verified!\n\n` +
                `Added: ${verificationResult.tokens} tokens\n` +
                `New balance: ${newTokens} tokens\n\n` +
                `Thank you for your payment!`
            );

            // Clean up payment state
            await PaymentState.deleteOne({ userId: user.userId });

            return { success: true };
        } else if (verificationResult.isPending) {
            // Special case for bank transfers
            await ctx.reply(
                `🏦 Bank Transfer\n\n` +
                `${verificationResult.message}`
            );
            return { success: false };
        } else {
            // All other failure cases
            await ctx.reply(
                `❌ Verification Failed\n\n` +
                `${verificationResult.message}`
            );
            return { success: false };
        }
    } catch (error) {
        console.error('Error in performVerification:', error);

        // Delete processing message if it exists
        if (processingMsg && processingMsg.message_id) {
            try {
                await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
            } catch (e) { }
        }

        await ctx.reply(
            `❌ Error\n\n` +
            `Unable to verify payment at this time.\n` +
            `Please try again later or contact support.`
        );
        return { success: false };
    }
}

async function handleRegularMessage(ctx, userId) {
    const user = await getUser(userId);
    if (!user) {
        return ctx.reply('You need to start the bot first. Please send /start.');
    }

    // Update streak and check tokens in one operation
    const [streakResult] = await Promise.all([
        updateUserStreak(userId),
        user.tokens < 1 ? Promise.reject(new Error('insufficient_tokens')) : Promise.resolve()
    ]).catch(err => {
        if (err.message === 'insufficient_tokens') {
            ctx.reply('You don\'t have enough tokens. Send /payments to top up.');
            return [null];
        }
        throw err;
    });

    if (!streakResult) return;

    // Create request and deduct token
    const requestState = new RequestState({
        userId,
        tokenCost: 1,
        messageId: ctx.message.message_id,
        status: 'processing',
        prompt: ctx.message.text,
        createdAt: new Date()
    });

    // CHANGE: Add cancel button to thinking message
    const thinkingMsg = await ctx.reply('Thinking...', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '❌ Cancel', callback_data: `cancel_${requestState._id}` }]
            ]
        }
    });

    try {
        console.log('📝 Text prompt sent to GPT');

        // Save request state and deduct token
        await Promise.all([
            requestState.save(),
            updateUser(userId, { tokens: user.tokens - 1 })
        ]);

        // Check if cancelled
        const currentRequest = await RequestState.findById(requestState._id);
        if (!currentRequest || currentRequest.status !== 'processing') return;

        // Get fresh user data with current conversation history
        const freshUser = await getUser(userId);

        // Get GPT response with current conversation history
        const gptAnswer = await askGpt(freshUser, ctx.message.text);
        console.log('✅ GPT response received');

        // Final cancellation check
        const finalRequest = await RequestState.findById(requestState._id);
        if (!finalRequest || finalRequest.status !== 'processing') return;

        // Update conversation history with both user message and GPT response
        const newConvoHistory = [
            ...(freshUser.convoHistory || []),
            { role: "user", content: ctx.message.text },
            { role: "assistant", content: gptAnswer }
        ];

        await Promise.all([
            updateUser(userId, { convoHistory: newConvoHistory }),
            requestState.updateOne({ status: 'completed' }),
            ctx.deleteMessage(thinkingMsg.message_id).catch(() => { }),
            sendLongMessage(ctx, gptAnswer, { parse_mode: 'HTML' }).then(() => console.log('📤 Message sent to user'))
        ]);

        // Check streak reward
        if (streakResult?.streakIncreased) {
            setTimeout(() => checkStreakReward(userId), 1000);
        }

    } catch (error) {
        console.error('❌ Error processing message:', error);

        // Always refund tokens on any error
        try {
            const currentUser = await getUser(userId);
            if (currentUser) {
                await updateUser(userId, { tokens: currentUser.tokens + 1 }); // Refund 1 token
                console.log('💰 Refunded 1 token to user');
            }
        } catch (refundError) {
            console.error('❌ Error refunding tokens:', refundError);
        }

        await Promise.all([
            requestState.updateOne({ status: 'failed', error: error.message }),
            ctx.deleteMessage(thinkingMsg.message_id).catch(() => { }),
            ctx.reply('Sorry, something went wrong. Your token has been refunded.')
        ]);
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

async function processMediaGroup(mediaGroupId, userId) {
    try {
        await ensureConnection();

        const mediaGroup = await MediaGroup.findOne({
            userId: userId,
            mediaGroupId: mediaGroupId,
            status: 'collecting'
        });

        if (!mediaGroup || new Date() < mediaGroup.lastActivity) {
            // Group not found or still collecting
            return;
        }

        // If we have at least one item, process the group
        if (mediaGroup.mediaItems.length > 0) {
            const user = await getUser(userId);
            if (!user) {
                return;
            }

            // Update status to processing
            mediaGroup.status = 'processing';
            await mediaGroup.save();

            // Deduct tokens
            user.tokens -= mediaGroup.tokenCost;
            await updateUser(userId, { tokens: user.tokens });

            // Send a processing message
            const telegramId = userId.substring(prefix.length);
            const processingMsg = await bot.telegram.sendMessage(telegramId, 'Processing your media group...');

            try {
                // Process all media files
                const mediaFiles = [];
                for (const item of mediaGroup.mediaItems) {
                    const fileBuffer = await downloadTelegramFile(bot, item.fileId);
                    const b64File = Buffer.from(fileBuffer).toString('base64');
                    mediaFiles.push({
                        b64: b64File,
                        type: item.type === 'photo' ? 'image' : 'document',
                        mimeType: item.mimeType || 'image/jpeg'
                    });
                }

                // Prepare the prompt
                let prompt = mediaGroup.caption || "Analyze these images together as a group.";
                prompt += " Please consider all images as part of a single request and provide one comprehensive response.";

                // Process with GPT by sending the first image with a special prompt
                // indicating more images are included in the analysis
                const firstFile = mediaFiles[0];

                // Create a combined prompt that mentions all images
                let fileDescription = `I've received ${mediaFiles.length} files from the user.\n`;
                mediaFiles.forEach((file, index) => {
                    fileDescription += `File ${index + 1}: ${file.type} (${file.mimeType})\n`;
                });

                // Add the original caption from the user
                const fullPrompt = `${fileDescription}\n${prompt}`;

                // Send first image to GPT with the context about other images
                let gptAnswer = await askGptWithAtt(
                    user,
                    firstFile.b64,
                    [firstFile.type, firstFile.mimeType],
                    fullPrompt
                );

                // Update the media group status
                mediaGroup.status = 'completed';
                mediaGroup.result = gptAnswer;
                await mediaGroup.save();

                // Inside processMediaGroup function, modify the response sending:
                console.log('GPT response:', gptAnswer);
                try {
                    await bot.telegram.sendMessage(telegramId, gptAnswer);
                    console.log('Response sent successfully');
                } catch (sendError) {
                    console.error('Error sending response:', sendError);
                    // Try sending a fallback message
                    try {
                        await bot.telegram.sendMessage(telegramId,
                            'I analyzed your images but had trouble sending the full response. Please try again with a single image.');
                    } catch (fallbackError) {
                        console.error('Even fallback message failed:', fallbackError);
                    }
                }

            } catch (error) {
                console.error('Error processing media group:', error);

                // Refund tokens
                user.tokens += mediaGroup.tokenCost;
                await updateUser(userId, { tokens: user.tokens });

                // Update group status
                mediaGroup.status = 'failed';
                mediaGroup.error = error.message;
                await mediaGroup.save();

                // Send error message
                const telegramId = userId.substring(prefix.length);
                await bot.telegram.sendMessage(
                    telegramId,
                    'Sorry, there was an error processing your media group. Your tokens have been refunded.'
                );
            }
        }
    } catch (error) {
        console.error('Error in processMediaGroup:', error);
    }
}

async function handleMediaGroupItem(ctx, user, mediaType) {
    const userId = prefix + ctx.from.id;
    const mediaGroupId = ctx.message.media_group_id;

    // Find or create the media group
    let mediaGroup = await MediaGroup.findOne({
        userId,
        mediaGroupId,
        status: 'collecting'
    });

    if (!mediaGroup) {
        mediaGroup = new MediaGroup({
            userId,
            mediaGroupId,
            status: 'collecting',
            caption: ctx.message.caption || '',
            mediaItems: [],
            tokenCost: 2,
            expiresAt: new Date(Date.now() + 60000),
            lastActivity: new Date()
        });
    } else {
        mediaGroup.lastActivity = new Date();
        if (ctx.message.caption && !mediaGroup.caption) {
            mediaGroup.caption = ctx.message.caption;
        }
    }

    // Add the media item without duplicates
    const fileId = mediaType === 'photo'
        ? ctx.message.photo[ctx.message.photo.length - 1].file_id
        : ctx.message.document.file_id;

    // Check for duplicates
    if (!mediaGroup.mediaItems.some(item => item.fileId === fileId)) {
        mediaGroup.mediaItems.push({
            fileId,
            type: mediaType,
            mimeType: mediaType === 'document' ? ctx.message.document.mime_type : 'image/jpeg'
        });
    }

    await mediaGroup.save();

    // Process after a delay (only once)
    if (mediaGroup.mediaItems.length === 1) {
        setTimeout(() => processMediaGroup(mediaGroupId, userId), 2000);
    }

    return;
}

/* === API Endpoints === */

router.post('/payment/callback', async (req, res) => {
    try {
        await ensureConnection();

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

/* === Message Splitting Utilities === */

function splitMessage(text, maxLength = 4096) {
    if (!text || text.length <= maxLength) {
        return [text];
    }

    const chunks = [];
    let currentChunk = '';

    // Split by paragraphs first (double newlines)
    const paragraphs = text.split('\n\n');

    for (let i = 0; i < paragraphs.length; i++) {
        const paragraph = paragraphs[i];

        // If adding this paragraph would exceed the limit
        if (currentChunk.length + paragraph.length + 2 > maxLength) {
            // If we have content in current chunk, save it
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }

            // If the paragraph itself is too long, split it by sentences
            if (paragraph.length > maxLength) {
                const sentences = paragraph.split(/(?<=[.!?])\s+/);

                for (const sentence of sentences) {
                    if (currentChunk.length + sentence.length + 1 > maxLength) {
                        if (currentChunk.trim()) {
                            chunks.push(currentChunk.trim());
                            currentChunk = '';
                        }

                        // If sentence is still too long, split by words
                        if (sentence.length > maxLength) {
                            const words = sentence.split(' ');

                            for (const word of words) {
                                if (currentChunk.length + word.length + 1 > maxLength) {
                                    if (currentChunk.trim()) {
                                        chunks.push(currentChunk.trim());
                                        currentChunk = '';
                                    }

                                    // If word is still too long, force split
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

    // Add any remaining content
    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    return chunks.filter(chunk => chunk.trim().length > 0);
}

async function sendLongMessage(ctx, text, options = {}) {
    const chunks = splitMessage(text);

    if (chunks.length === 1) {
        const formattedText = formatForMarkdownV2(chunks[0]);
        return await ctx.reply(formattedText, {
            ...options,
            parse_mode: 'MarkdownV2'
        });
    }

    const messages = [];

    for (let i = 0; i < chunks.length; i++) {
        let messageText = formatForMarkdownV2(chunks[i]);

        if (i === 0 && chunks.length > 1) {
            messageText += '\n\n📄 _\\(continued\\.\\.\\.\\)_';
        } else if (i === chunks.length - 1) {
            messageText = `📄 _\\(continued from above\\)_\n\n${messageText}`;
        } else {
            messageText = `📄 _\\(continued from above\\)_\n\n${messageText}\n\n📄 _\\(continued\\.\\.\\.\\)_`;
        }

        const sentMessage = await ctx.reply(messageText, {
            ...options,
            parse_mode: 'MarkdownV2'
        });
        messages.push(sentMessage);

        if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    return messages;
}

/* === Serverless Handler === */

export default async function handler(req, res) {
    try {
        console.log('Received webhook request from Telegram');

        if (req.method !== 'POST') {
            if (req.method === 'GET') {
                // Set the webhook URL on GET request
                if (req.query.setwebhook === 'true') {
                    const webhookUrl = `${process.env.WEBHOOK_URL}/api/telegram`;
                    await bot.telegram.setWebhook(webhookUrl);
                    return res.status(200).json({
                        success: true,
                        message: `Webhook set to ${webhookUrl}`
                    });
                }
                return res.status(200).send('Telegram webhook is active');
            }
            return res.status(405).send('Method not allowed');
        }

        await ensureConnection();
        console.log('📡 Processing Telegram update...');

        await bot.handleUpdate(req.body);
        console.log('✅ Telegram update processed successfully');

        res.status(200).send('OK');
    } catch (error) {
        console.error('Error handling webhook:', error);
        // Always return 200 to Telegram to prevent retry attempts
        res.status(200).send('Error processed');
    }
}


/* === Import the missing models === */

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
        default: 10
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
    mediaGroupId: {  // Critical field for identifying groups
        type: String,
        required: true
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
        },
        mimeType: String,
        fileName: String
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

// Schedule cleanup of expired media groups
setInterval(async () => {
    try {
        await ensureConnection();

        // Find expired collecting groups
        const expiredGroups = await MediaGroup.find({
            status: 'collecting',
            expiresAt: { $lt: new Date() }
        });

        for (const group of expiredGroups) {
            // Update status to cancelled
            group.status = 'cancelled';
            await group.save();
        }
    } catch (error) {
        console.error('Error cleaning up media groups:', error);
    }
}, 60000);

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

// Weekly analytics endpoint (for cron jobs)
router.post('/analytics/weekly', async (req, res) => {
    try {
        const authToken = req.headers.authorization?.split(' ')[1];
        if (authToken !== process.env.ADMIN_API_KEY) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { sendAnalytics } = await import('../scripts/analytics.js');
        const analytics = await sendAnalytics('week');

        res.status(200).json({
            success: true,
            message: 'Weekly analytics sent',
            data: analytics
        });

    } catch (error) {
        console.error('Weekly analytics API error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Monthly analytics endpoint
router.post('/analytics/monthly', async (req, res) => {
    try {
        const authToken = req.headers.authorization?.split(' ')[1];
        if (authToken !== process.env.ADMIN_API_KEY) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { sendAnalytics } = await import('../scripts/analytics.js');
        const analytics = await sendAnalytics('month');

        res.status(200).json({
            success: true,
            message: 'Monthly analytics sent',
            data: analytics
        });

    } catch (error) {
        console.error('Monthly analytics API error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

export const tg = { router, bot, setupWebhook };