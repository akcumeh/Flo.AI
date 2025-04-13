import express from 'express';
import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import { getMessageContent, downloadTelegramFile } from '../utils/getMsgContent.js';

dotenv.config();

const router = express.Router();
const prefix = 'tg:';

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
import Anthropic from '@anthropic-ai/sdk';
import { message } from 'telegraf/filters';

// Create bot with token from .env file
const bot = new Telegraf(process.env.BOT_TOKEN);

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

bot.command('payments', async (ctx) => {
    try {
        const userId = prefix + ctx.from.id;
        const user = await getUser(userId);
        if (!user) {
            return ctx.reply('You need to start the bot first. Please send /start.');
        }

        await ctx.reply('Tokens cost 1,000 naira for 25 tokens.\n\nTo make a payment, please visit: https://flutterwave.com/pay/jinkrgxqambh');
    } catch (error) {
        console.error('Error in /payments command:', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
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

// Handle regular messages
bot.on('message', async (ctx) => {
    // Ignore commands (they're handled above)
    if (ctx.message.text && ctx.message.text.startsWith('/')) {
        return;
    }

    try {
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

        if (user.tokens < 1) {
            return ctx.reply('You have no tokens left. Send /payments to top up.');
        }

        // Send "thinking" message
        const thinkingMsg = await ctx.reply('Thinking...');

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