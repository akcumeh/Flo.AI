import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

export const anthropic = new Anthropic({
    apiKey: process.env.CLAUDE_API_KEY
});


var users = new Map();


// User Management
export function addUser({ id, name, tokens=25 }) {
    const userData = {
        id,
        name,
        tokens,
        streak: 0,
        convoHistory: [],
        lastTokenReward: new Date().toISOString(),
    };

    users.set(id, userData);

    return userData;
};

export function getUser(id) {
    return users.get(id);
};

export function updateUser(id, updates){
    const user = getUser(id);

    if (user) {
        users.set(id, { ...user, ...updates });
        return getUser(id);
    };

    return null;
};


// Token Management
export function addTokens({ id, amt }) {
    const user = users.get(id);
    user.tokens += amt;

    return user.tokens;
};

export function tokenRefresh(user) {
    const now = new Date();
    const lastTokenReward = new Date(user.lastTokenReward);
    const elapsedTime = (now - lastTokenReward) / (1000 * 60 * 60);

    if ((elapsedTime >= 24) && (true /* !paidAnything */) && (user.tokens < 25)) {
        updateUser(user.id, {
            tokens: 25,
            lastTokenReward: now.toISOString(),
        });
    };

    return user;
};


// Conversation Management
export async function askClaude(user, prompt) {
    const convo = user.convoHistory;
    convo.push(
        { role: "user", content: prompt },
    );
    const claude = await anthropic.messages.create({
        model: "claude-3-5-sonnet-latest",
        max_tokens: 512,
        system: "You are Florence*, a highly knowledgeable teacher on every subject. Answer questions clearly.",
        messages: convo,
    });

    convo.push(
        { role: "assistant", content: claude.content[0].text }
    );
    console.log(convo);
    updateUser(user.id, { convoHistory: convo });

    return claude.content[0].text;
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