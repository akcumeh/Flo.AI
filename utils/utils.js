import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import axios from 'axios';
import { User } from '../models/user.js';
import { Payments } from '../models/payments.js';
import { connectDB } from '../db/db.js';

dotenv.config();

// Initialize Anthropic client
let anthropic = new Anthropic({
    apiKey: process.env.CLAUDE_API_KEY
});
console.log('✅ Claude API initialized successfully');

// User Management
export async function addUser({ id, name, tokens = 25 }) {
    await connectDB();

    const userData = {
        userId: id,
        name: name,
        tokens: tokens || 25,
        streak: 0,
        convoHistory: [],
        convos: [],
        lastTokenReward: new Date(),
    };

    const user = await User.create(userData);
    console.log(`Added user: ${id}`);
    return user;
}

export async function getUser(id) {
    await connectDB();
    return await User.findOne({ userId: id });
}

export async function updateUser(id, updates) {
    await connectDB();
    return await User.findOneAndUpdate(
        { userId: id },
        { $set: updates },
        { new: true }
    );
}

// Token Management
export async function addTokens({ id, amt }) {
    await connectDB();

    const user = await User.findOne({ userId: id });
    if (!user) return null;

    user.tokens += amt;
    await user.save();
    console.log(`Added ${amt} tokens to user ${id}`);
    return user.tokens;
}

export async function tokenRefresh(user) {
    await connectDB();

    const now = new Date();
    const lastTokenReward = new Date(user.lastTokenReward);
    const elapsedTime = (now - lastTokenReward) / (1000 * 60 * 60);

    if ((elapsedTime >= 24) && (user.tokens < 10)) {
        user.tokens = 10;
        user.lastTokenReward = now;
        await user.save();
        console.log(`Refreshed tokens for user ${user.userId}`);
    }

    return user;
}

// Conversation Management
export async function askClaude(user, prompt) {
    try {
        // If this is a new conversation, add the user's prompt
        if (user.convoHistory.length === 0) {
            user.convoHistory.push({ role: "user", content: prompt });
        }

        let convo = user.convoHistory;

        console.log('Sending request to Claude API...');
        const claude = await anthropic.messages.create({
            model: "claude-3-5-sonnet-latest",
            max_tokens: 1024,
            system: "You are Florence*, a highly knowledgeable teacher on every subject. You are patiently guiding a student through a difficult concept using clear, detailed yet concise answers.",
            messages: convo,
        });

        // Extract Claude's response
        let claudeAnswer = claude.content[0].text;

        // Add Claude's response to conversation history
        convo.push({ role: "assistant", content: claudeAnswer });

        // Update user's conversation history
        user.convoHistory = convo;
        await updateUser(user.userId, { convoHistory: convo });

        return claudeAnswer;
    } catch (error) {
        console.error('Error calling Claude API:', error);
        throw error;
    }
}

/**
 * Function to ask Claude with an attachment (image or document)
 * @param {Object} user - User object
 * @param {string} b64 - Base64 encoded file
 * @param {Array} fileType - Array with type and MIME type
 * @param {string} prompt - Text prompt
 * @returns {Promise<string>} - Claude's response
 */
export async function askClaudeWithAtt(user, b64, fileType, prompt) {
    try {
        console.log('Sending request to Claude API...');

        // Validate fileType[1] is one of Claude's supported types
        const supportedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
        if (!supportedMimeTypes.includes(fileType[1])) {
            console.warn(`Unsupported MIME type: ${fileType[1]}. Defaulting to image/jpeg.`);
            fileType[1] = 'image/jpeg';
        }

        // Create message content with attachment
        const messageContent = [
            {
                type: fileType[0],
                source: {
                    type: "base64",
                    media_type: fileType[1],
                    data: b64
                }
            },
            {
                type: "text",
                text: prompt
            }
        ];

        // Initialize the conversation if it's empty
        if (!user.convoHistory || user.convoHistory.length === 0) {
            user.convoHistory = [{
                role: "user",
                content: messageContent
            }];
        } else {
            // Add this message to the conversation history
            user.convoHistory.push({
                role: "user",
                content: messageContent
            });
        }

        // Send the message to Claude
        const claudeWithAtt = await anthropic.messages.create({
            model: "claude-3-5-sonnet-latest",
            max_tokens: 1024,
            system: "You are Florence*, a highly knowledgeable teacher on every subject. You are patiently guiding a student through a difficult concept using clear, detailed yet concise answers.",
            messages: user.convoHistory,
        });

        // Check if the response contains content
        if (!claudeWithAtt.content || claudeWithAtt.content.length === 0 || !claudeWithAtt.content[0].text) {
            throw new Error('Empty or invalid response from Claude API');
        }

        // Extract Claude's response text
        let claudeAnswer = claudeWithAtt.content[0].text;

        // Add Claude's response to conversation history
        user.convoHistory.push({
            role: "assistant",
            content: claudeAnswer
        });

        // Update user's conversation history in database
        await updateUser(user.userId, { convoHistory: user.convoHistory });

        return claudeAnswer;
    } catch (error) {
        console.error('Error in askClaudeWithAtt:', error);
        throw error; // Re-throw to be handled by the caller
    }
}

// Attachment Management
// Image conversion function
export function convertImgToBase64(buffer) {
    // Convert buffer directly to base64
    return Buffer.from(buffer).toString('base64');
};

// For URLs
export async function convertUrlToBase64(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data, 'binary').toString('base64');
    } catch (error) {
        console.error('Error converting URL to base64:', error);
        throw error;
    }
};

// PDFs
export async function convertPDFToBase64(file) {
    const response = await axios.get(file, { responseType: 'arraybuffer' });
    return Buffer.from(response.data, 'binary').toString('base64');
};

// Payment processing
export async function payWithBankTrf(user, tokens = 25, amt = 1000) {
    await connectDB();

    // Create payment record
    const payment = await Payments.create({
        userId: user.userId,
        name: user.name,
        tokens: tokens,
        time: new Date(),
        payId: `${"FLO" + (new Date()).getTime() + "-" + user.userId}`,
        paymentMethod: "Bank Transfer",
    });

    // Add tokens to user
    user.tokens += tokens;
    await user.save();

    console.log(`Added ${tokens} tokens to user ${user.userId} via bank transfer`);
    return { success: true, paymentId: payment.payId, message: 'Payment completed successfully' };
}

export async function payWithCard(user, tokens = 25, amt = 1000) {
    await connectDB();

    // Create payment record
    const payment = await Payments.create({
        userId: user.userId,
        name: user.name,
        tokens: tokens,
        time: new Date(),
        payId: `${"FLO" + (new Date()).getTime() + "-" + user.userId}`,
        paymentMethod: "Card",
    });

    // Add tokens to user
    user.tokens += tokens;
    await user.save();

    console.log(`Added ${tokens} tokens to user ${user.userId} via card payment`);
    return { success: true, paymentId: payment.payId, message: 'Payment completed successfully' };
}

// Welcome messages
export function walkThru(tokens) {
    return `Hello there! Welcome to Florence*.

Interacting with Florence* costs you tokens*. Every now and then you'll get these, but you can also purchase more of them at any time.

You currently have ${tokens} tokens*. Feel free to send your text (one token*), images (two tokens*), or documents (two tokens*) and get answers immediately.

Here are a few helpful commands for a smooth experience:

/start - Florence* is now listening to you.
/about - for more about Florence*.
/tokens - see how many tokens you have left.
/payments - Top up your tokens.
/conversations - View and continue previous conversations.

Please note: Every message except commands will be considered a prompt.`;
}