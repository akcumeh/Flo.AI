import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { config } from '../config/index.js';
import * as userRepo from '../repositories/user.repository.js';
import * as transactionRepo from '../repositories/transaction.repository.js';
import * as convoRepo from '../repositories/conversation.repository.js';
import * as fileRepo from '../repositories/file.repository.js';
import * as assistantService from '../services/assistant.service.js';
import * as paystackService from '../services/paystack.service.js';
import * as streakService from '../services/streak.service.js';
import * as prepService from '../services/prep.service.js';
import { sendAnalytics } from '../services/analytics.service.js';
import { ClaudeTimeoutError } from '../utils/errors.js';
import { RequestState } from '../../models/requestState.js';
import { PaymentState } from '../../models/paymentState.js';
import { MediaGroup } from '../../models/mediaGroup.js';
import VerificationState from '../../models/verificationState.js';
import { downloadTelegramFile } from '../../utils/getMsgContent.js';
import { ensureConnection } from '../../db/connection.js';
import type { IUser, ConversationMessage, ISession } from '../types/index.js';

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
/prep - Generate a scored quiz from your own materials.
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

// Telegram's legacy Markdown parser reads the brand's trailing asterisk as an
// unpaired bold marker: it either throws (dumping the whole reply to plain
// text) or silently pairs with the next *bold* span and corrupts it. Swapping
// in the lookalike U+2217 keeps the star visible AND keeps bold rendering.
function protectBrandStar(text: string): string {
    return text.replace(/(?<!\*)Florence\*(?!\*)/g, 'Florence∗');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendLongMessage(ctx: any, text: string, options: object = {}): Promise<unknown> {
    const chunks = splitMessage(protectBrandStar(text));

    if (chunks.length === 1) {
        try {
            return await ctx.reply(chunks[0], { ...options, parse_mode: 'Markdown' });
        } catch (err) {
            console.error('Markdown parse failed, falling back to plain text:', (err as Error).message);
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
            console.error('Markdown parse failed on chunk, falling back to plain text:', (err as Error).message);
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

bot.command('prep', async (ctx) => {
    try {
        const userId = PREFIX + ctx.from!.id;
        await ensureConnection();

        const active = await prepService.getActiveSession(userId);
        if (active) {
            await ctx.reply('You already have a prep session running. Send /exit to end it first.');
            return;
        }

        const user = await userRepo.findUser(userId);
        if (!user) {
            await ctx.reply('You need to start the bot first. Please send /start.');
            return;
        }
        if (user.tokens < 2) {
            await ctx.reply('You need at least 2 tokens to use prep mode. Send /payments to top up.');
            return;
        }

        const session = await prepService.start(userId, 'tg');
        const count = parseQuestionCount(ctx.message.text);
        if (count) session.requestedCount = count;
        await session.save();

        await ctx.reply(
            `Prep mode is on.\n\nUpload up to ${prepService.MAX_FILES} files (PDFs or images) to base your questions on. Each generated question costs 1 token.\n\nWhen you've sent your files, tell me how many questions you want (a number from 1 to ${prepService.MAX_QUESTIONS}).\n\nSend /exit at any time to leave prep mode.`
        );
    } catch (error) {
        console.error('Error in /prep command:', error);
        await ctx.reply('Sorry, something went wrong starting prep mode. Please try again.');
    }
});

bot.command('exit', async (ctx) => {
    try {
        const userId = PREFIX + ctx.from!.id;
        await ensureConnection();

        const session = await prepService.getActiveSession(userId);
        if (!session) {
            await ctx.reply("You're not in a prep session right now.");
            return;
        }

        const result = await prepService.exit(session);
        if (result.wasCompleted) {
            await ctx.reply("Prep session closed. You're back to normal chat, ask me anything!");
        } else {
            await ctx.reply(
                `Prep session ended. ${result.cost} token${result.cost === 1 ? '' : 's'} charged. You now have ${result.balanceAfter} tokens. Back to normal chat!`
            );
        }
    } catch (error) {
        console.error('Error in /exit command:', error);
        await ctx.reply('Sorry, something went wrong ending the session.');
    }
});

bot.command('users', async (ctx) => {
    try {
        const tgId = String(ctx.from!.id);
        if (!(config.adminTelegramIds as readonly string[]).includes(tgId)) {
            await ctx.reply('Sorry, this is an invalid command.');
            return;
        }
        await ctx.reply('Fetching analytics...');
        await sendAnalytics('week');
    } catch (error) {
        console.error('Error in /users command:', error);
        await ctx.reply('Sorry, something went wrong fetching analytics.');
    }
});

bot.command('feedback', async (ctx) => {
    ctx.reply(
        'Enjoying Florence*?\n\nEven if you absolutely hate it, please let us know:\n\nhttps://forms.gle/SwhApkszXZJGcRyP7\n\nYour feedback is greatly appreciated and helps us improve Florence*. Thank you for your input.'
    );
});

bot.command('help', async (ctx) => {
    await ctx.reply(
        `Here are the commands you can use:\n\n \
/start - Start a NEW conversation thread\n \
/about - Learn more about Florence*\n \
/tokens - See how many tokens you have left\n \
/payments - Top up your tokens\n \
/conversations - View and continue previous conversations\n\
/transactions - View your transaction history\n\
/prep - Generate a scored quiz from your own materials\n\
/exit - Leave prep mode\n\

/research - Get help with your research/thesis/project [coming soon]\n \
/feedback - Send feedback to the developers\n \
/verify - Verify your payment status\n \
/cancel - Cancel an ongoing request\n\
/help - Get a list of all commands [YOU ARE HERE]`
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

        const request = await RequestState.findOneAndUpdate(
            { _id: requestId, userId, status: 'processing' },
            { $set: { status: 'cancelled' } }
        );

        if (!request) {
            await ctx.answerCbQuery('This request already ended.');
            try {
                await ctx.deleteMessage();
            } catch {
                // ignore
            }
            return;
        }

        const refundAmount = (request as unknown as { tokenCost?: number }).tokenCost ?? 1;
        const user = await userRepo.findUser(userId);
        if (user) {
            await userRepo.updateUser(userId, { tokens: user.tokens + refundAmount });
        }

        await ctx.answerCbQuery('Prompt cancelled. Tokens refunded.');
        try {
            await ctx.deleteMessage();
        } catch {
            // ignore
        }
        await ctx.reply(
            `Prompt cancelled. ${refundAmount} token${refundAmount === 1 ? '' : 's'} refunded. You can try again.`
        );
    } catch (error) {
        console.error('Error handling cancel request:', error);
        await ctx.answerCbQuery('An error occurred while cancelling', { show_alert: true });
    }
});

bot.action(/^exam_(\d+)$/, async (ctx) => {
    try {
        const userId = PREFIX + ctx.from!.id;
        await ensureConnection();

        const session = await prepService.getActiveSession(userId);
        if (!session || session.status !== 'quizzing') {
            await ctx.answerCbQuery('This quiz has already ended.');
            return;
        }

        const question = prepService.currentQuestion(session);
        const optIndex = parseInt(ctx.match![1], 10);
        const chosen = question?.options?.[optIndex];
        if (!question || chosen === undefined) {
            await ctx.answerCbQuery('That option is no longer available.');
            return;
        }

        await ctx.answerCbQuery();
        // Drop the keyboard so the question can't be answered twice.
        try {
            await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        } catch {
            // ignore
        }

        await processPrepAnswer(ctx, session, chosen);
    } catch (error) {
        console.error('Error handling prep answer:', error);
        await ctx.answerCbQuery('Something went wrong grading that answer.', { show_alert: true });
    }
});

/* === Message Handlers === */

bot.on(message('photo'), async (ctx) => {
    // An active prep session (or a /prep caption) claims the upload before
    // the normal media/charge path runs.
    {
        const exUserId = PREFIX + ctx.from!.id;
        const exCaption = ctx.message.caption ?? '';
        if (await maybeHandlePrepUpload(ctx, exUserId, exCaption, 'photo')) return;
    }

    // Grouped media arrives as one update per file sharing a media_group_id.
    // Route them to the collector so the whole group is one request charged once,
    // instead of each file being processed and charged separately.
    if (ctx.message.media_group_id) {
        await handleMediaGroupItem(ctx, 'photo');
        return;
    }

    const userId = PREFIX + ctx.from!.id;
    const messageId = ctx.message.message_id;

    await sweepStaleRequests(userId);

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
    requestState.thinkingMessageId = thinkingMsg.message_id;
    requestState.chatId = ctx.chat.id;

    try {
        await requestState.save();
        await userRepo.updateUser(userId, { tokens: user.tokens - 2 });

        const imgBuffer = await downloadTelegramFile(bot as unknown as { telegram: { getFile(id: string): Promise<{ file_path: string; file_size?: number }> } }, fileId);

        const currentRequest = await RequestState.findById(requestState._id);
        if (!currentRequest || (currentRequest as unknown as { status: string }).status !== 'processing') return;

        const anthropicFileId = await assistantService.uploadChatFile(
            Buffer.from(imgBuffer),
            `image-${Date.now()}.jpg`,
            'image/jpeg'
        );
        fileRepo.trackFile(userId, anthropicFileId);
        const response = await assistantService.processMediaMessage(
            userId,
            { type: 'file', anthropicFileId, mimeType: 'image/jpeg' },
            caption
        );

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
    // Prep session (or /prep caption) claims the upload first.
    {
        const exUserId = PREFIX + ctx.from!.id;
        const exCaption = ctx.message.caption ?? '';
        if (await maybeHandlePrepUpload(ctx, exUserId, exCaption, 'document')) return;
    }

    // See the photo handler: grouped documents are collected, not processed singly.
    if (ctx.message.media_group_id) {
        await handleMediaGroupItem(ctx, 'document');
        return;
    }

    const userId = PREFIX + ctx.from!.id;
    const messageId = ctx.message.message_id;

    await sweepStaleRequests(userId);

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
    requestState.thinkingMessageId = thinkingMsg.message_id;
    requestState.chatId = ctx.chat.id;

    try {
        await requestState.save();
        await userRepo.updateUser(userId, { tokens: user.tokens - 2 });

        const fileBuffer = await downloadTelegramFile(bot as unknown as { telegram: { getFile(id: string): Promise<{ file_path: string; file_size?: number }> } }, fileId);

        const currentRequest = await RequestState.findById(requestState._id);
        if (!currentRequest || (currentRequest as unknown as { status: string }).status !== 'processing') return;

        const anthropicFileId = await assistantService.uploadChatFile(Buffer.from(fileBuffer), fileName, mimeType);
        fileRepo.trackFile(userId, anthropicFileId);
        const response = await assistantService.processMediaMessage(
            userId,
            { type: 'file', anthropicFileId, mimeType },
            caption
        );

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

        // Active prep session intercepts all plain text (counts, answers).
        const session = await prepService.getActiveSession(userId);
        if (session) {
            await handlePrepText(ctx, session, msg.text ?? '');
            return;
        }

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

async function sweepStaleRequests(userId: string): Promise<void> {
    const cutoff = new Date(Date.now() - 65_000);
    const stale = await RequestState.find({ userId, status: 'processing', createdAt: { $lt: cutoff } });

    for (const req of stale) {
        const r = req as unknown as {
            _id: unknown;
            tokenCost?: number;
            thinkingMessageId?: number;
            chatId?: string | number;
        };

        const claimed = await RequestState.findOneAndUpdate(
            { _id: r._id, status: 'processing' },
            { $set: { status: 'failed', error: 'timed out (swept)' } }
        );
        if (!claimed) continue;

        const refund = r.tokenCost ?? 1;
        const user = await userRepo.findUser(userId);
        if (user) await userRepo.updateUser(userId, { tokens: user.tokens + refund });

        if (r.chatId != null && r.thinkingMessageId != null) {
            try {
                await bot.telegram.deleteMessage(r.chatId as number, r.thinkingMessageId);
            } catch {
                // ignore
            }
            try {
                await bot.telegram.sendMessage(
                    r.chatId as number,
                    'Your previous question took too long and timed out. You were not charged. Please try again.'
                );
            } catch {
                // ignore
            }
        }
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleRegularMessage(ctx: any, userId: string): Promise<void> {
    await sweepStaleRequests(userId);

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
    requestState.thinkingMessageId = thinkingMsg.message_id;
    requestState.chatId = ctx.chat.id;

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
            const safeAnswer = protectBrandStar(claudeAnswer);
            try {
                await bot.telegram.sendMessage(telegramId, safeAnswer, { parse_mode: 'Markdown' });
            } catch {
                await bot.telegram.sendMessage(telegramId, safeAnswer);
            }
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

/* === Prep Helpers === */

function parseQuestionCount(text: string | undefined): number | null {
    if (!text) return null;
    const match = text.match(/(\d+)/);
    if (!match) return null;
    const n = parseInt(match[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function truncateButton(text: string, max = 90): string {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// Returns true if this upload was claimed by prep mode (so the normal media
// path must not run).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function maybeHandlePrepUpload(
    ctx: any,
    userId: string,
    caption: string,
    mediaType: 'photo' | 'document'
): Promise<boolean> {
    await ensureConnection();
    let session = await prepService.getActiveSession(userId);
    const startsPrep = /^\/prep\b/i.test(caption.trim());
    if (!session && !startsPrep) return false;

    if (!session) {
        const user = await userRepo.findUser(userId);
        if (!user) {
            await ctx.reply('Please send /start first.');
            return true;
        }
        if (user.tokens < 2) {
            await ctx.reply('You need at least 2 tokens to use prep mode. Send /payments to top up.');
            return true;
        }
        session = await prepService.start(userId, 'tg');
        const n = parseQuestionCount(caption);
        if (n) {
            session.requestedCount = n;
            await session.save();
        }
    }

    if (session.status === 'quizzing') {
        await ctx.reply("You're in the middle of a quiz. Answer the current question, or send /exit to stop.");
        return true;
    }

    if (session.fileIds.length >= prepService.MAX_FILES) {
        await ctx.reply(
            `You've already added the maximum of ${prepService.MAX_FILES} files. Tell me how many questions you'd like.`
        );
        return true;
    }

    try {
        let fileId: string;
        let fileName: string;
        let mimeType: string;
        if (mediaType === 'photo') {
            fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            fileName = `image-${Date.now()}.jpg`;
            mimeType = 'image/jpeg';
        } else {
            fileId = ctx.message.document.file_id;
            fileName = ctx.message.document.file_name || 'document.pdf';
            mimeType = ctx.message.document.mime_type || 'application/pdf';
            if (mimeType !== 'application/pdf' && !fileName.toLowerCase().endsWith('.pdf')) {
                await ctx.reply('For prep mode I can only use images and PDF documents. Please send a PDF or image.');
                return true;
            }
        }

        const buffer = await downloadTelegramFile(
            bot as unknown as { telegram: { getFile(id: string): Promise<{ file_path: string; file_size?: number }> } },
            fileId
        );
        const { count } = await prepService.addFile(session, buffer, fileName, mimeType);

        const more =
            session.requestedCount > 0
                ? `Send "go" to generate ${session.requestedCount} question${session.requestedCount === 1 ? '' : 's'}, or upload more files.`
                : `Tell me how many questions you'd like (1-${prepService.MAX_QUESTIONS}), or upload more files. Each question costs 1 token.`;
        await ctx.reply(`File ${count}/${prepService.MAX_FILES} added. ${more}`);
    } catch (error) {
        console.error('Prep upload error:', error);
        await ctx.reply('Sorry, I could not add that file. Please try again.');
    }
    return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handlePrepText(ctx: any, session: ISession, text: string): Promise<void> {
    if (session.status === 'quizzing') {
        await processPrepAnswer(ctx, session, text);
        return;
    }

    if (session.fileIds.length === 0) {
        await ctx.reply(
            'Upload at least one file (PDF or image) before we start, or send /exit to leave prep mode.'
        );
        return;
    }

    const n = parseQuestionCount(text);
    const go = /^(go|start|yes|y)$/i.test(text.trim());
    if (n) {
        await startPrepQuiz(ctx, session, n);
    } else if (go && session.requestedCount > 0) {
        await startPrepQuiz(ctx, session, session.requestedCount);
    } else {
        await ctx.reply(
            `How many questions would you like? Send a number from 1 to ${prepService.MAX_QUESTIONS}. Each one costs 1 token.`
        );
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function startPrepQuiz(ctx: any, session: ISession, requested: number): Promise<void> {
    const effective = await prepService.setCount(session, requested);
    if (effective < requested) {
        await ctx.reply(
            `You have enough tokens for ${effective} question${effective === 1 ? '' : 's'} right now, so I'll generate that many.`
        );
    }
    await ctx.reply(
        `Generating ${effective} question${effective === 1 ? '' : 's'} from your material. This can take a moment...`
    );

    try {
        await prepService.generate(session);
    } catch (error) {
        console.error('Prep generation failed:', error);
        session.status = 'collecting';
        await session.save();
        await ctx.reply(
            'Sorry, I had trouble generating questions from those files. Send a number to try again, or /exit to leave.'
        );
        return;
    }

    await sendCurrentPrepQuestion(ctx, session);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendCurrentPrepQuestion(ctx: any, session: ISession): Promise<void> {
    const q = prepService.currentQuestion(session);
    if (!q) return;

    const number = session.currentIndex + 1;
    const total = session.questions.length;
    const header = `Question ${number}/${total}\n\n${q.question}`;

    if (q.type === 'mcq' && q.options && q.options.length > 0) {
        const rows = q.options.map((opt, i) => [
            { text: truncateButton(`${String.fromCharCode(65 + i)}. ${opt}`), callback_data: `exam_${i}` },
        ]);
        await ctx.reply(header, { reply_markup: { inline_keyboard: rows } });
    } else {
        await sendLongMessage(ctx, `${header}\n\nType your answer.`);
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processPrepAnswer(ctx: any, session: ISession, answerText: string): Promise<void> {
    const thinking = await ctx.reply('Checking your answer...');
    let outcome;
    try {
        outcome = await prepService.submitAnswer(session, answerText);
    } catch (error) {
        console.error('Prep submitAnswer failed:', error);
        await ctx.deleteMessage(thinking.message_id).catch(() => {});
        await ctx.reply('Sorry, I had trouble grading that. Please try answering again.');
        return;
    }
    await ctx.deleteMessage(thinking.message_id).catch(() => {});

    const verdict = outcome.correct ? 'Correct!' : 'Not quite.';
    await sendLongMessage(ctx, `${verdict}\n\nSource: ${outcome.sourceLabel}\n\n${outcome.explanation}`);

    if (outcome.done) {
        const result = await prepService.complete(session);
        let msg = `Quiz complete! You scored ${result.correctCount}/${result.total}.`;
        if (result.failedSources.length > 0) {
            msg += `\n\nWorth revisiting: ${result.failedSources.join(', ')}.`;
        }
        msg += `\n\n${result.cost} token${result.cost === 1 ? '' : 's'} charged. You have ${result.balanceAfter} tokens left.\n\nYou're back to normal chat. Send /prep to run another quiz.`;
        await sendLongMessage(ctx, msg);
    } else {
        await sendCurrentPrepQuestion(ctx, session);
    }
}

/* === Error Handler === */

bot.catch((err, ctx) => {
    console.error('Telegraf error:', err);
    ctx.reply('An error occurred. Please try again later.');
});
