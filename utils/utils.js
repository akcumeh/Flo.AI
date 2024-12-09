import { User } from '../models/user.js';
import { connectDB } from './db.js';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

export const anthropic = new Anthropic({
    apiKey: process.env.CLAUDE_API_KEY
});


// User Management
export async function addUser({ id, name, tokens = 25 }) {
    await connectDB();

    const userData = {
        userId: id,
        name,
        tokens,
        streak: 0,
        convoHistory: [],
        lastTokenReward: new Date()
    };

    const user = await User.create(userData);
    return user;
};

export async function getUser(id) {
    await connectDB();
    return await User.findOne({ userId: id });
};

export async function updateUser(id, updates) {
    await connectDB();
    return await User.findOneAndUpdate(
        { userId: id },
        { $set: updates },
        { new: true }
    );
};

// Token Management
export async function addTokens({ id, amt }) {
    await connectDB();
    const user = await User.findOne({ userId: id });
    if (!user) return null;

    user.tokens += amt;
    await user.save();
    return user.tokens;
};

export async function tokenRefresh(user) {
    const now = new Date();
    const lastTokenReward = new Date(user.lastTokenReward);
    const elapsedTime = (now - lastTokenReward) / (1000 * 60 * 60);

    if ((elapsedTime >= 24) && (user.tokens < 25)) {
        return await updateUser(user.userId, {
            tokens: 25,
            lastTokenReward: now
        });
    }

    return user;
};


// Conversation Management
export async function askClaude(user, prompt) {
    await connectDB();
    const convo = user.convoHistory;

    if (convo.length === 0) {
        convo.push({ role: "user", content: prompt });
    }

    const claude = await anthropic.messages.create({
        model: "claude-3-5-sonnet-latest",
        max_tokens: 1024,
        system: "You are Florence*, a highly knowledgeable teacher on every subject. You are patiently guiding a student through a difficult concept using clear, detailed yet concise answers.",
        messages: convo,
    });

    let claudeAnswer = claude.content[0].text;
    convo.push({ role: "assistant", content: claudeAnswer });

    await updateUser(user.userId, { convoHistory: convo });
    return claudeAnswer;
};

export async function askClaudeWithMedia(user, prompt, caption) {
    const convo = user.convoHistory;
    if (convo.length === 0) {
        convo.push({
            role: "user",
            content: prompt || {
                type: "image",
                source: {
                    type: "base64",
                    media_type: "image/png",
                    data: ``
                }
            }
        },
        {
            type: "text",
            text: caption || "What is in this image?"
        });
    };
    const claude = await anthropic.messages.create({
        model: "claude-3-5-sonnet-latest",
        max_tokens: 1024,
        system: "You are Florence*, a highly knowledgeable teacher on every subject. You are patiently guiding a student through a difficult concept using clear, detailed yet concise answers.",
        messages: convo,
    });

    let claudeAnswer = claude.content[0].text;
    convo.push(
        { role: "assistant", content: claudeAnswer }
    );
    updateUser(user.id, { convoHistory: convo });

    return claudeAnswer;
};


// Helper Functions
export function mediaType(url, contentType) {
    if (contentType) {
        contentType = contentType.toLowerCase();
        const typeMap = {
            "jpeg": "image/jpeg",
            "jpg": "image/jpeg",
            "png": "image/png",
            "gif": "image/gif",
            "webp": "image/webp",
            "pdf": "application/pdf",
        }
    };

    for (const [key, value] of Object.entries(typeMap)) {
        if (contentType.includes(key)) {
            return value;
        };
    }
};

export async function getBase64FromUrl(url) {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
};

// Welcome messages
export function walkThru(tokens) {
    return `Hello there! Welcome to Florence*, your educational assistant at your fingertips.

Interacting with Florence* costs you tokens*. Every now and then you'll get these, but you can also purchase more of them at any time.

You currently have ${tokens} tokens*. Feel free to send your text (one token*), images (two tokens*), or documents (two tokens*) and get answers immediately.

Here are a few helpful commands for a smooth experience:

/start - Florence* is now listening to you.
/about - for more about Florence*.
/tokens - see how many tokens you have left.
/streak - see your streak.
/payments - Top up your tokens* in a click.

Please note: Every message except commands will be considered a prompt.`;
};