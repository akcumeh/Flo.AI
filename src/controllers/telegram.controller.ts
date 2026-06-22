import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { config } from '../config/index.js';
import * as userRepo from '../repositories/user.repository.js';
import * as transactionRepo from '../repositories/transaction.repository.js';
import * as convoRepo from '../repositories/conversation.repository.js';
import * as assistantService from '../services/assistant.service.js';
import * as paystackService from '../services/paystack.service.js';
import * as streakService from '../services/streak.service.js';
import { ClaudeTimeoutError } from '../utils/errors.js';
import { RequestState } from '../../models/requestState.js';
import { PaymentState } from '../../models/paymentState.js';
import { MediaGroup } from '../../models/mediaGroup.js';
import VerificationState from '../../models/verificationState.js';
import { downloadTelegramFile } from '../../utils/getMsgContent.js';
import { ensureConnection } from '../../db/connection.js';
import type { IUser, ConversationMessage } from '../types/index.js';

export const bot = new Telegraf(config.botToken);
const PREFIX = 'tg-';

/* === Utilities === */

function welcomeMessage(tokens: number): string {
    return `Hello there! Welcome to Florence*, the educational assistant at your fingertips.

Florence* is here to help you with your studies, and answer any questions you may have. You can ask anything from math and science to finance, history and literature. Just type your question, send a picture or a document, and you'll be provided a detailed answer within 3-30 seconds.

Interacting with Florence* costs you tokens*. Every now and then you'll get these, but you can also purchase more of them at any time.

Text-only - 1 token
Image - 2 tokens
Document - 2 tokens

You currently have ${tokens} tokens*.

Here are a few helpful commands for a smooth experience:

/start - Florence* is now listening to you. This also starts a NEW conversation thread.
/about - Learn more about Florence*.
/tokens - See how many tokens you have left.
/payments - Top up your tokens.
/conversations - View and continue previous conversations.
/stem - Answer math & science questions even better. [coming soon]
/research - Get help with your research/thesis/project. [coming soon]
/transactions - View your transaction history
/feedback - Send feedback to the developers.
/verify [reference number] - Verify your payment status.

/help - Get a list of all commands.

Please note: Every message except commands will be considered a prompt.`;
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

function splitMessage(text: string, maxLength = 4096): string[] {
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
                            const words = sentence.split(' ');
                            for (const word of words) {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendLongMessage(ctx: any, text: string, options: object = {}): Promise<unknown> {
    const chunks = splitMessage(text);

    if (chunks.length === 1) {
        try {
            return await ctx.reply(chunks[0], { ...options, parse_mode: 'Markdown' });
        } catch (err) {
            // Fall back to plain text so the user gets the answer unformatted.
            console.error('Markdown parse failed, retrying as plain text:', (err as Error).message);
            return ctx.reply(chunks[0], options);
        }
    }

    const messages = [];
    for (let i = 0; i < chunks.length; i++) {
        let messageText = chunks[i];
        if (i === 0) messageText += '\n\n_(continued...)_';
        else if (i === chunks.length - 1) messageText = `_(continued from above)_\n\n${messageText}`;
        else messageText = `_(continued from above)_\n\n${messageText}\n\n_(continued...)_`;

        let sent;
        try {
            sent = await ctx.reply(messageText, { ...options, parse_mode: 'Markdown' });
        } catch (err) {
            console.error('Markdown parse failed on chunk, retrying as plain text:', (err as Error).message);
            sent = await ctx.reply(messageText, options);
        }
        messages.push(sent);
        if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 100));
    }
    return messages;
}

/* === Inline Query === */

bot.on('inline_query', async (ctx) => {
    if (ctx.inlineQuery.query.toLowerCase().startsWith('verify')) {
        await ctx.answerInlineQuery(
            [
                {
                    id: '1',
                    type: 'article',
                    title: 'Verify Payment',
                    description: 'Enter your payment reference number',
                    input_message_content: {
                        message_text: 'Please enter your payment reference number to verify:',
                    },
                },
            ],
            { cache_time: 0 }
        );
    }
});

/* === Command Handlers === */

bot.command('start', async (ctx) => {
    try {
        const userId = PREFIX + ctx.from!.id;
        await ensureConnection();

        let user = await userRepo.findUser(userId);
        let isNewUser = false;

        if (!user) {
            isNewUser = true;
            user = await userRepo.createUser({ id: userId, name: ctx.from!.first_name, tokens: 10 });
        }

        if (!isNewUser && user.convoHistory && user.convoHistory.length > 0) {
            const title = computeConvoTitle(user.convoHistory);
            await convoRepo.resetHistory(userId, title);
        } else {
            await convoRepo.resetHistory(userId);
        }

        if (isNewUser) {
            await ctx.reply(welcomeMessage(user.tokens));
            await ctx.reply(
                'Please be aware that Florence* is currently unable to process document uploads due to an internal error. We are working to resolve this issue as soon as possible. Thank you for your patience!'
            );
        } else {
            await ctx.reply(
                `Hello ${ctx.from!.first_name}, what do you need help with today?\n\nYou have ${user.tokens} tokens.`
            );
        }
    } catch (error) {
        console.error('Error in /start command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('about', async (ctx) => {
    await ctx.reply(
        'Florence* is the educational assistant at your fingertips.\n\nI can help you with a variety of tasks, including:\n- Answering questions\n- Providing explanations\n- Offering study tips\n\nJust ask away!'
    );
});

bot.command('tokens', async (ctx) => {
    try {
        const userId = PREFIX + ctx.from!.id;
        await ensureConnection();
        const user = await userRepo.findUser(userId);
        if (!user) return ctx.reply('You need to start the bot first. Please send /start.');
        await ctx.reply(`You have ${user.tokens} tokens. To top up, send /payments.`);
    } catch (error) {
        console.error('Error in /tokens command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('payments', async (ctx) => {
    try {
        const userId = PREFIX + ctx.from!.id;
        await ensureConnection();
        const user = await userRepo.findUser(userId);
        if (!user) return ctx.reply('You need to start the bot first. Please send /start.');

        await PaymentState.findOneAndUpdate(
            { userId },
            { step: 'bundle_select', createdAt: new Date() },
            { upsert: true, new: true }
        );

        const bundleRows: Array<Array<{ text: string; callback_data: string }>> = [];
        const { BUNDLES } = paystackService;
        for (let i = 0; i < BUNDLES.length; i += 2) {
            bundleRows.push(
                BUNDLES.slice(i, i + 2).map((b) => ({
                    text: `₦${b.amount.toLocaleString()} – ${b.tokens} tokens`,
                    callback_data: `bundle_${b.amount}`,
                }))
            );
        }

        return ctx.reply('Please choose your bundle:', {
            reply_markup: { inline_keyboard: bundleRows },
        });
    } catch (error) {
        console.error('Error in /payments command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('streak', async (ctx) => {
    try {
        const userId = PREFIX + ctx.from!.id;
        const streakInfo = await streakService.getStreakInfo(userId);
        if (!streakInfo) return ctx.reply('You need to start the bot first. Please send /start.');

        const firstName = streakInfo.name.split(' ')[0];
        await ctx.reply(
            `Hi ${firstName}, you have a streak of ${streakInfo.streak} ${streakInfo.streak === 1 ? 'day' : 'days'}. Keep learning with Florence*!`
        );
    } catch (error) {
        console.error('Error in /streak command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('transactions', async (ctx) => {
    try {
        const userId = PREFIX + ctx.from!.id;
        await ensureConnection();
        const user = await userRepo.findUser(userId);
        if (!user) return ctx.reply('You need to start the bot first. Please send /start.');

        const transactions = await transactionRepo.findUserTransactions(userId);
        if (!transactions.length) return ctx.reply("You haven't made any transactions yet.");

        let msg =
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
            msg += `• ${date} ${time} | ${tx.reference} | ₦${tx.amount} | +${tx.tokens} tokens`;
            if (tx.status !== 'success') msg += ` (${tx.status})`;
            msg += '\n';
        }

        await ctx.reply(msg);
    } catch (error) {
        console.error('Error in /transactions command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('verify', async (ctx) => {
    try {
        const userId = PREFIX + ctx.from!.id;
        await ensureConnection();
        const user = await userRepo.findUser(userId);
        if (!user) return ctx.reply('You need to start the bot first. Please send /start.');

        const parts = ctx.message.text.split(' ');
        if (parts.length < 2) {
            return ctx.reply('Please provide a reference number. Usage: /verify [reference]');
        }

        const reference = parts.slice(1).join(' ').trim();
        const verifyMsg = await ctx.reply('Verifying your payment...');
        await performVerification(ctx, user, reference, verifyMsg);
    } catch (error) {
        console.error('Error in /verify command:', error);
        await ctx.reply(
            'Sorry, something went wrong with payment verification. Please try again or contact support.'
        );
    }
});

bot.command('conversations', async (ctx) => {
    try {
        const userId = PREFIX + ctx.from!.id;
        await ensureConnection();
        const user = await userRepo.findUser(userId);
        if (!user) return ctx.reply('You need to start the bot first. Please send /start.');

        const convos = await convoRepo.getSavedConversations(userId);
        if (!convos.length) {
            return ctx.reply('You have no saved conversations yet. Start a new one by sending a message!');
        }

        const buttons = convos.map((convo, index) => [
            Markup.button.callback(convo.title || `Conversation ${index + 1}`, `convo_${index}`),
        ]);
        await ctx.reply('Your saved conversations:', Markup.inlineKeyboard(buttons));
    } catch (error) {
        console.error('Error in /conversations command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.command('stem', async (ctx) => {
    ctx.reply('This feature is coming soon :)');
});

bot.command('research', async (ctx) => {
    ctx.reply('The research feature is coming soon :)');
});

bot.command('feedback', async (ctx) => {
    ctx.reply(
        'Enjoying Florence*?\n\nEven if you absolutely hate it, please let us know:\n\nhttps://forms.gle/SwhApkszXZJGcRyP7\n\nYour feedback is greatly appreciated and helps us improve Florence*. Thank you for your input.'
    );
});

bot.command('help', async (ctx) => {
    await ctx.reply(
        `Here are some commands you can use:\n\n \
/start - Start a NEW conversation thread\n \
/about - Learn more about Florence*\n \
/tokens - see how many tokens you have left\n \
/payments - Top up your tokens\n \
/conversations - View and continue previous conversations\n\
/transactions - View your transaction history\n\
/stem - Answer math & science questions even better [coming soon]\n \
/research - Get help with your research/thesis/project [coming soon]\n \
/feedback - Send feedback to the developers\n \
/verify - Verify your payment status\n \
/cancel - Cancel an ongoing request\n\
/help - Get a list of all commands`
    );
});

/* === Callback Action Handlers === */

bot.action(/^bundle_(\d+)$/, async (ctx) => {
    try {
        const userId = PREFIX + ctx.from!.id;
        await ensureConnection();
        const user = await userRepo.findUser(userId);
        if (!user) return ctx.reply('You need to start the bot first. Please send /start.');

        const amount = parseInt(ctx.match![1]);
        const bundle = paystackService.BUNDLES.find((b) => b.amount === amount);
        if (!bundle) return ctx.answerCbQuery('Invalid bundle. Please try /payments again.');

        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

        const state = await PaymentState.findOneAndUpdate(
            { userId },
            {
                step: user.email ? 'processing' : 'email',
                amount: bundle.amount,
                tokens: bundle.tokens,
            },
            { upsert: true, new: true }
        );

        if (user.email) {
            (state as unknown as { email?: string; save(): Promise<void> }).email = user.email;
            await (state as unknown as { save(): Promise<void> }).save();
            return processPayment(ctx, user, state as unknown as PaymentStateDoc);
        }

        return ctx.reply(
            'Please enter your email address for payment receipt (we only need this once):',
            { reply_markup: { force_reply: true, selective: true } }
        );
    } catch (error) {
        console.error('Error in bundle selection:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.action(/convo_(\d+)/, async (ctx) => {
    try {
        const userId = PREFIX + ctx.from!.id;
        await ensureConnection();

        const convoIndex = parseInt(ctx.match![1], 10);
        const convos = await convoRepo.getSavedConversations(userId);

        if (!convos[convoIndex]) return ctx.answerCbQuery('Conversation not found');

        await userRepo.updateUser(userId, { convoHistory: [...convos[convoIndex].messages] });
        await ctx.answerCbQuery(`Loaded: ${convos[convoIndex].title}`);
        await ctx.reply(
            `Loaded conversation: "${convos[convoIndex].title}"\nYou can now continue where you left off.`
        );
    } catch (error) {
        console.error('Error handling conversation selection:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

bot.action(/^verify_(.+)$/, async (ctx) => {
    try {
        await ensureConnection();
        const userId = PREFIX + ctx.from!.id;
        const user = await userRepo.findUser(userId);
        if (!user) {
            return ctx.answerCbQuery('Session expired. Please start the bot again with /start.', { show_alert: true });
        }

        const reference = ctx.match![1];
        await ctx.answerCbQuery('Verifying your payment...');
        const processingMsg = await ctx.reply('Verifying your payment...');

        const result = await performVerification(ctx, user, reference, processingMsg);

        if (result?.success) {
            try {
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
            } catch {
                // ignore edit errors
            }
        }
    } catch (error) {
        console.error('Error in verify payment button handler:', error);
        await ctx.answerCbQuery('An error occurred while verifying payment', { show_alert: true });
        await ctx.reply(
            'Sorry, something went wrong with payment verification. Please try again or contact support.'
        );
    }
});

bot.action(/^cancel_(.+)$/, async (ctx) => {
    try {
        const requestId = ctx.match![1];
        const userId = PREFIX + ctx.from!.id;
        await ensureConnection();

        // Atomically claim the request as cancelled. Scoping by userId enforces
        // ownership, and status:'processing' guarantees only one path (this cancel,
        // or the message handler's success/failure) ever transitions it — so the
        // refund below runs at most once. Tokens are charged on start now, so a
        // cancelled in-flight request must be refunded.
        const request = await RequestState.findOneAndUpdate(
            { _id: requestId, userId, status: 'processing' },
            { $set: { status: 'cancelled' } }
        );

        if (!request) {
            await ctx.answerCbQuery('This request is already completed or cancelled.', { show_alert: true });
            return;
        }

        const refundAmount = (request as unknown as { tokenCost?: number }).tokenCost ?? 1;
        const user = await userRepo.findUser(userId);
        if (user) {
            await userRepo.updateUser(userId, { tokens: user.tokens + refundAmount });
        }

        await ctx.answerCbQuery('Request cancelled');
        try {
            await ctx.deleteMessage();
        } catch {
            // ignore
        }
        await ctx.reply('You cancelled the prompt. You can try again.');
    } catch (error) {
        console.error('Error handling cancel request:', error);
        await ctx.answerCbQuery('An error occurred while cancelling', { show_alert: true });
    }
});

/* === Message Handlers === */

bot.on(message('photo'), async (ctx) => {
    // Grouped media arrives as one update per file sharing a media_group_id.
    // Route them to the collector so the whole group is one request charged once,
    // instead of each file being processed and charged separately.
    if (ctx.message.media_group_id) {
        await handleMediaGroupItem(ctx, 'photo');
        return;
    }

    const userId = PREFIX + ctx.from!.id;
    const messageId = ctx.message.message_id;

    const existingRequest = await RequestState.findOne({ userId, messageId });
    if (existingRequest) return;

    let user = await userRepo.findUser(userId);
    const isNewUser = !user;
    if (!user) {
        user = await userRepo.createUser({ id: userId, name: ctx.from!.first_name, tokens: 10 });
    }

    if (user.tokens < 2) {
        return ctx.reply("You don't have enough tokens for an image upload. Send /payments to top up.");
    }

    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const caption = ctx.message.caption || 'Assess the following image.';

    const requestState = new RequestState({
        userId,
        tokenCost: 2,
        messageId,
        status: 'processing',
        prompt: caption,
        isMedia: true,
        mediaType: 'photo',
        mediaFileId: fileId,
        createdAt: new Date(),
    });

    const thinkingMsg = await ctx.reply('Thinking...', {
        reply_markup: {
            inline_keyboard: [[{ text: 'Cancel', callback_data: `cancel_${requestState._id}` }]],
        },
    });

    try {
        await requestState.save();
        // Charge on start (balance was guarded above). Refunded by the catch on
        // failure or by the cancel handler, each via an atomic claim.
        await userRepo.updateUser(userId, { tokens: user.tokens - 2 });

        const imgBuffer = await downloadTelegramFile(bot as unknown as { telegram: { getFile(id: string): Promise<{ file_path: string; file_size?: number }> } }, fileId);
        const b64img = Buffer.from(imgBuffer).toString('base64');

        const currentRequest = await RequestState.findById(requestState._id);
        if (!currentRequest || (currentRequest as unknown as { status: string }).status !== 'processing') return;

        const response = await assistantService.processMediaMessage(userId, b64img, 'image/jpeg', caption);

        // Atomically claim processing -> completed. If a cancel won the race it
        // already flipped + refunded, so we must not send a (now free) answer.
        const claimedDone = await RequestState.findOneAndUpdate(
            { _id: requestState._id, status: 'processing' },
            { $set: { status: 'completed' } }
        );
        if (!claimedDone) return;

        await Promise.all([
            ctx.deleteMessage(thinkingMsg.message_id).catch(() => {}),
            sendLongMessage(ctx, response),
        ]);

        if (isNewUser) {
            const updated = await userRepo.findUser(userId);
            await ctx.reply(welcomeMessage(updated?.tokens ?? user.tokens - 2));
        }

        setTimeout(() => streakService.checkStreakReward(userId).catch(console.error), 1000);
    } catch (error) {
        console.error('Error processing photo:', error);

        const claimed = await RequestState.findOneAndUpdate(
            { _id: requestState._id, status: 'processing' },
            { $set: { status: 'failed', error: (error as Error).message } }
        );
        if (!claimed) return;

        const refundUser = await userRepo.findUser(userId);
        if (refundUser) await userRepo.updateUser(userId, { tokens: refundUser.tokens + 2 });

        await ctx.deleteMessage(thinkingMsg.message_id).catch(() => {});
        await ctx.reply('Sorry, there was an error processing your image. You have not been charged.');
    }
});

bot.on(message('document'), async (ctx) => {
    // See the photo handler: grouped documents are collected, not processed singly.
    if (ctx.message.media_group_id) {
        await handleMediaGroupItem(ctx, 'document');
        return;
    }

    const userId = PREFIX + ctx.from!.id;
    const messageId = ctx.message.message_id;

    const existingRequest = await RequestState.findOne({ userId, messageId });
    if (existingRequest) return;

    let user = await userRepo.findUser(userId);
    const isNewUser = !user;
    if (!user) {
        user = await userRepo.createUser({ id: userId, name: ctx.from!.first_name, tokens: 10 });
    }

    if (user.tokens < 2) {
        return ctx.reply("You don't have enough tokens for a document upload. Send /payments to top up.");
    }

    const fileId = ctx.message.document.file_id;
    const fileName = ctx.message.document.file_name || 'document';
    const mimeType = ctx.message.document.mime_type || 'application/octet-stream';
    const caption = ctx.message.caption || `Analyze this ${fileName} document.`;

    if (!['application/pdf'].includes(mimeType) && !fileName.toLowerCase().endsWith('.pdf')) {
        await ctx.reply(
            'Sorry, I can only process PDF documents. Please convert your document to PDF format and try again.'
        );
        if (isNewUser) await ctx.reply(welcomeMessage(user.tokens));
        return;
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
        createdAt: new Date(),
    });

    const thinkingMsg = await ctx.reply('Thinking...', {
        reply_markup: {
            inline_keyboard: [[{ text: 'Cancel', callback_data: `cancel_${requestState._id}` }]],
        },
    });

    try {
        await requestState.save();
        // Charge on start (balance guarded above); refunded on failure/cancel.
        await userRepo.updateUser(userId, { tokens: user.tokens - 2 });

        const fileBuffer = await downloadTelegramFile(bot as unknown as { telegram: { getFile(id: string): Promise<{ file_path: string; file_size?: number }> } }, fileId);
        const b64File = fileBuffer.toString('base64');

        const currentRequest = await RequestState.findById(requestState._id);
        if (!currentRequest || (currentRequest as unknown as { status: string }).status !== 'processing') return;

        const response = await assistantService.processMediaMessage(userId, b64File, mimeType, caption);

        // Atomically claim processing -> completed. If a cancel won the race it
        // already flipped + refunded, so we must not send a (now free) answer.
        const claimedDone = await RequestState.findOneAndUpdate(
            { _id: requestState._id, status: 'processing' },
            { $set: { status: 'completed' } }
        );
        if (!claimedDone) return;

        await Promise.all([
            ctx.deleteMessage(thinkingMsg.message_id).catch(() => {}),
            sendLongMessage(ctx, response),
        ]);

        if (isNewUser) {
            const updated = await userRepo.findUser(userId);
            await ctx.reply(welcomeMessage(updated?.tokens ?? user.tokens - 2));
        }

        setTimeout(() => streakService.checkStreakReward(userId).catch(console.error), 1000);
    } catch (error) {
        console.error('Error processing document:', error);

        const claimed = await RequestState.findOneAndUpdate(
            { _id: requestState._id, status: 'processing' },
            { $set: { status: 'failed', error: (error as Error).message } }
        );
        if (!claimed) return;

        const refundUser = await userRepo.findUser(userId);
        if (refundUser) await userRepo.updateUser(userId, { tokens: refundUser.tokens + 2 });

        const msg = (error as Error).message.toLowerCase();
        let errorMessage: string;
        if (msg.includes('timeout') || msg.includes('timed out')) {
            errorMessage =
                'Sorry, the request timed out while processing your document. Please try uploading it again or use a smaller file. You have not been charged.';
        } else if (msg.includes('fetch failed') || msg.includes('download failed')) {
            errorMessage =
                'Sorry, there was a problem downloading your document. Please try uploading it again. You have not been charged.';
        } else if (msg.includes('econnreset') || msg.includes('connection')) {
            errorMessage =
                'Sorry, there was a connection error. Please try uploading your document again. You have not been charged.';
        } else {
            errorMessage =
                'Sorry, there was an error processing your document. You have not been charged.';
        }

        await ctx.deleteMessage(thinkingMsg.message_id).catch(() => {});
        await ctx.reply(errorMessage);
    }
});

bot.on('message', async (ctx) => {
    const msg = ctx.message as { text?: string };
    if (msg.text?.startsWith('/')) return;

    try {
        const userId = PREFIX + ctx.from!.id;
        const messageId = (ctx.message as { message_id: number }).message_id;
        await ensureConnection();

        const existingRequest = await RequestState.findOne({ userId, messageId });
        if (existingRequest) return;

        const paymentState = await PaymentState.findOne({ userId });
        if (paymentState && (paymentState as unknown as { step: string }).step !== 'init') {
            await handlePaymentMessage(ctx, userId, paymentState as unknown as PaymentStateDoc);
            return;
        }

        await handleRegularMessage(ctx, userId);
    } catch (error) {
        console.error('Error in message handler:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

/* === Helper Types === */

interface PaymentStateDoc {
    userId: string;
    step: string;
    amount: number;
    tokens: number;
    email?: string;
    reference?: string;
    save(): Promise<void>;
}

/* === Helper Functions === */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handlePaymentMessage(ctx: any, userId: string, state: PaymentStateDoc): Promise<void> {
    try {
        const user = await userRepo.findUser(userId);
        if (!user) return ctx.reply('Session expired. Please start again with /payments.');

        const msg = ctx.message as { text?: string };
        if (state.step === 'email' && msg.text) {
            const email = msg.text.trim();
            if (!email.includes('@') || !email.includes('.')) {
                return ctx.reply('Please enter a valid email address.');
            }
            await userRepo.updateUser(userId, { email });
            state.email = email;
            state.step = 'processing';
            await state.save();
            return processPayment(ctx, user, state);
        }
    } catch (error) {
        console.error('Error in handlePaymentMessage:', error);
        await ctx.reply('An error occurred with the payment process. Please try again or contact support.');
        throw error;
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processPayment(ctx: any, user: IUser, state: PaymentStateDoc): Promise<void> {
    try {
        await ctx.reply('Setting up your payment...');
        const callbackUrl = `${config.botWebhookUrl}/payment`;

        const paymentResult = await paystackService.initializePayment(
            user.userId,
            state.email ?? user.email,
            state.amount,
            state.tokens,
            callbackUrl
        );

        if (paymentResult.success) {
            state.reference = paymentResult.reference;
            await state.save();

            await ctx.reply(
                `Please complete your payment of ₦${state.amount} for ${state.tokens} tokens:\n\n${paymentResult.authorizationUrl}\n\nOnce you've paid, tap the button below to verify and receive your tokens:`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: 'Verify Payment',
                                    callback_data: `verify_${paymentResult.reference}`,
                                },
                            ],
                        ],
                    },
                }
            );

            await ctx.reply(
                `Tokens are only added after you verify. Tap to copy your verification command:\n\`/verify ${paymentResult.reference}\`\n\nPaste it here once payment is done.`,
                { parse_mode: 'Markdown' }
            );
        } else {
            console.error('Payment initialization failed:', paymentResult.message);
            await ctx.reply("Sorry, we couldn't start your payment. Please try again later.");
        }
    } catch (error) {
        console.error('Error processing payment:', error);
        await ctx.reply('Sorry, something went wrong with the payment process. Please try again.');
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function performVerification(ctx: any, user: IUser, reference: string, processingMsg: { message_id: number } | null): Promise<{ success: boolean }> {
    try {
        const cleanReference = reference.replace(/[^a-zA-Z0-9-]/g, '');

        const existingVerification = await VerificationState.findOne({
            userId: user.userId,
            reference: cleanReference,
            status: 'verified',
        });

        if (existingVerification) {
            if (processingMsg?.message_id) {
                try {
                    await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
                } catch {
                    // ignore
                }
            }
            await ctx.reply(
                `Already Verified\n\nThis payment reference has already been used.\nThe tokens were previously added to your account.\n\nCurrent balance: ${user.tokens} tokens`
            );
            return { success: false };
        }

        const result = await paystackService.verifyTransaction(cleanReference);

        if (processingMsg?.message_id) {
            try {
                await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
            } catch {
                // ignore
            }
        }

        if (result.success) {
            const newTokens = user.tokens + (result.tokens ?? 0);
            await userRepo.updateUser(user.userId, { tokens: newTokens });

            await VerificationState.create({
                userId: user.userId,
                reference: cleanReference,
                status: 'verified',
                tokens: result.tokens,
                verifiedAt: new Date(),
            });

            await PaymentState.deleteOne({ userId: user.userId });

            await ctx.reply(
                `Payment Verified!\n\nAdded: ${result.tokens} tokens\nNew balance: ${newTokens} tokens\n\nThank you for your payment!`
            );
            return { success: true };
        } else if (result.isPending) {
            await ctx.reply(`Bank Transfer\n\n${result.message}`);
            return { success: false };
        } else {
            await ctx.reply(`Verification Failed\n\n${result.message}`);
            return { success: false };
        }
    } catch (error) {
        console.error('Error in performVerification:', error);
        if (processingMsg?.message_id) {
            try {
                await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
            } catch {
                // ignore
            }
        }
        await ctx.reply(
            `Error\n\nUnable to verify payment at this time.\nPlease try again later or contact support.`
        );
        return { success: false };
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleRegularMessage(ctx: any, userId: string): Promise<void> {
    let user = await userRepo.findUser(userId);
    const isNewUser = !user;
    if (!user) {
        user = await userRepo.createUser({ id: userId, name: ctx.from?.first_name ?? 'there', tokens: 10 });
    }

    const text = (ctx.message as { text?: string }).text ?? '';
    const messageId = (ctx.message as { message_id: number }).message_id;

    const requestState = new RequestState({
        userId,
        tokenCost: 1,
        messageId,
        status: 'processing',
        prompt: text,
        createdAt: new Date(),
    });

    const thinkingMsg = await ctx.reply('Thinking...', {
        reply_markup: {
            inline_keyboard: [[{ text: 'Cancel', callback_data: `cancel_${requestState._id}` }]],
        },
    });

    try {
        await requestState.save();

        if (user.tokens < 1) {
            await requestState.updateOne({ status: 'failed' });
            await ctx.deleteMessage(thinkingMsg.message_id).catch(() => {});
            await ctx.reply("You don't have enough tokens. Send /payments to top up.");
            return;
        }
        // Charge on start. The catch refunds if anything below throws; the cancel
        // handler refunds if the user bails. Both refund through an atomic claim of
        // the request, so exactly one refund ever happens.
        await userRepo.updateUser(userId, { tokens: user.tokens - 1 });

        const response = await assistantService.processTextMessage(userId, text);

        // Atomically claim processing -> completed. If a cancel won the race it
        // already flipped + refunded, so we must not send a (now free) answer.
        const claimedDone = await RequestState.findOneAndUpdate(
            { _id: requestState._id, status: 'processing' },
            { $set: { status: 'completed' } }
        );
        if (!claimedDone) return;

        await Promise.all([
            ctx.deleteMessage(thinkingMsg.message_id).catch(() => {}),
            sendLongMessage(ctx, response),
        ]);

        if (isNewUser) {
            const updated = await userRepo.findUser(userId);
            await ctx.reply(welcomeMessage(updated?.tokens ?? user.tokens - 1));
        }

        setTimeout(() => streakService.checkStreakReward(userId).catch(console.error), 1000);
    } catch (error) {
        console.error('Error processing message:', error);

        // Atomically flip processing -> failed. If the claim misses, the request
        // was already cancelled/finalized elsewhere and refunded there, so we must
        // not refund (or reply) again.
        const claimed = await RequestState.findOneAndUpdate(
            { _id: requestState._id, status: 'processing' },
            { $set: { status: 'failed', error: (error as Error).message } }
        );
        if (!claimed) return;

        const refundUser = await userRepo.findUser(userId);
        if (refundUser) await userRepo.updateUser(userId, { tokens: refundUser.tokens + 1 });

        const message =
            error instanceof ClaudeTimeoutError
                ? 'That question took too long to research and timed out. You have not been charged. Try asking it in smaller parts, or ask one thing at a time.'
                : 'Sorry, something went wrong. You have not been charged. Please try again.';

        await ctx.deleteMessage(thinkingMsg.message_id).catch(() => {});
        await ctx.reply(message);
    }
}

async function processMediaGroup(mediaGroupId: string, userId: string): Promise<void> {
    try {
        await ensureConnection();

        const mediaGroup = await MediaGroup.findOne({
            userId,
            mediaGroupId,
            status: 'collecting',
        });

        if (!mediaGroup) return;
        const mg = mediaGroup as unknown as {
            status: string;
            lastActivity: Date;
            mediaItems: Array<{ fileId: string; type: string; mimeType?: string }>;
            tokenCost: number;
            caption?: string;
            result?: string;
            error?: string;
            save(): Promise<void>;
        };

        if (new Date() < mg.lastActivity) return;
        if (!mg.mediaItems.length) return;

        const user = await userRepo.findUser(userId);
        if (!user) return;

        const telegramId = userId.substring(PREFIX.length);

        if (user.tokens < mg.tokenCost) {
            mg.status = 'failed';
            mg.error = 'Insufficient tokens';
            await mg.save();
            await bot.telegram.sendMessage(
                telegramId,
                "You don't have enough tokens for media processing. Send /payments to top up."
            );
            return;
        }

        mg.status = 'processing';
        await mg.save();

        const processingMsg = await bot.telegram.sendMessage(telegramId, 'Processing your media group...');

        // Charge on start (balance guarded above); refunded in the catch on failure.
        await userRepo.updateUser(userId, { tokens: user.tokens - mg.tokenCost });

        try {
            const mediaFiles: Array<{ b64: string; mimeType: string }> = [];
            for (const item of mg.mediaItems) {
                const fileBuffer = await downloadTelegramFile(
                    bot as unknown as { telegram: { getFile(id: string): Promise<{ file_path: string; file_size?: number }> } },
                    item.fileId
                );
                mediaFiles.push({
                    b64: Buffer.from(fileBuffer).toString('base64'),
                    mimeType: item.mimeType || 'image/jpeg',
                });
            }

            let fileDescription = `I've received ${mediaFiles.length} files from the user.\n`;
            mediaFiles.forEach((file, i) => {
                fileDescription += `File ${i + 1}: ${file.mimeType}\n`;
            });
            const fullPrompt = `${fileDescription}\n${mg.caption || 'Analyze these images together as a group.'} Please consider all images as part of a single request and provide one comprehensive response.`;

            // Send every file in the group to Claude in one turn, not just the first.
            const claudeAnswer = await assistantService.processMultiMediaMessage(
                userId,
                mediaFiles,
                fullPrompt
            );

            mg.status = 'completed';
            mg.result = claudeAnswer;
            await mg.save();

            try {
                await bot.telegram.deleteMessage(telegramId, processingMsg.message_id);
            } catch {
                // ignore
            }
            await bot.telegram.sendMessage(telegramId, claudeAnswer, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error processing media group:', error);

            const refundUser = await userRepo.findUser(userId);
            if (refundUser) {
                await userRepo.updateUser(userId, { tokens: refundUser.tokens + mg.tokenCost });
            }

            mg.status = 'failed';
            mg.error = (error as Error).message;
            await mg.save();

            try {
                await bot.telegram.deleteMessage(telegramId, processingMsg.message_id);
            } catch {
                // ignore
            }
            await bot.telegram.sendMessage(
                telegramId,
                'Sorry, there was an error processing your media group. Your tokens have been refunded.'
            );
        }
    } catch (error) {
        console.error('Error in processMediaGroup:', error);
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleMediaGroupItem(ctx: any, mediaType: 'photo' | 'document'): Promise<void> {
    const userId = PREFIX + ctx.from!.id;
    const mediaGroupId = ctx.message.media_group_id as string;

    let mediaGroup = await MediaGroup.findOne({ userId, mediaGroupId, status: 'collecting' });
    const mg = mediaGroup as unknown as {
        lastActivity: Date;
        caption?: string;
        mediaItems: Array<{ fileId: string; type: string; mimeType: string }>;
        save(): Promise<void>;
    } | null;

    if (!mg) {
        mediaGroup = new MediaGroup({
            userId,
            mediaGroupId,
            status: 'collecting',
            caption: ctx.message.caption || '',
            mediaItems: [],
            tokenCost: 2,
            expiresAt: new Date(Date.now() + 60000),
            lastActivity: new Date(),
        });
    } else {
        mg.lastActivity = new Date();
        if (ctx.message.caption && !mg.caption) mg.caption = ctx.message.caption as string;
    }

    const currentMg = mediaGroup as unknown as {
        mediaItems: Array<{ fileId: string; type: string; mimeType: string }>;
        save(): Promise<void>;
    };

    const fileId =
        mediaType === 'photo'
            ? (ctx.message.photo as Array<{ file_id: string }>)[ctx.message.photo.length - 1].file_id
            : (ctx.message.document as { file_id: string }).file_id;

    if (!currentMg.mediaItems.some((item) => item.fileId === fileId)) {
        currentMg.mediaItems.push({
            fileId,
            type: mediaType,
            mimeType:
                mediaType === 'document'
                    ? (ctx.message.document as { mime_type?: string }).mime_type || 'application/pdf'
                    : 'image/jpeg',
        });
    }

    await currentMg.save();

    if (currentMg.mediaItems.length === 1) {
        setTimeout(() => processMediaGroup(mediaGroupId, userId), 2000);
    }
}

/* === Error Handler === */

bot.catch((err, ctx) => {
    console.error('Telegraf error:', err);
    ctx.reply('An error occurred. Please try again later.');
});
