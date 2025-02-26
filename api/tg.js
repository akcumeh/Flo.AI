
import express from 'express';
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import {
    addUser,
    
} from '../';

dotenv.config();

const router = express.Router();

import {
    addUser,
    getUser,
    askClaude,
    walkThru,
    updateUser
} from '../utils/utils.js';

const bot = new Telegraf(process.env.BOT_TOKEN);
const prefix = 'tg:';

bot.command('start', ctx => {
    let user = getUser(prefix + ctx.from.id);
    if (!user) {
        addUser({
            id: prefix + ctx.from.id,
            name: ctx.from.first_name,
            tokens: 25
        });
        user = getUser(prefix + ctx.from.id);
        ctx.reply(walkThru(user.tokens));
    };
    
    updateUser(user.id, { convoHistory: [] });
    return ctx.reply(`Hello ${ctx.from.first_name}, welcome to Florence*! What do you need help with today?\n\nYou have ${user.tokens} tokens.`);
});

bot.command('about', (ctx) => {
    ctx.reply('Florence* is the educational assistant at your fingertips. More about Florence*. <link>.');
});

bot.command('tokens', (ctx) => {
    let user = getUser(prefix + ctx.from.id);
    ctx.reply(`You have ${user.tokens} tokens. To top up, send /payments.`);
});

bot.command('payments', (ctx) => {
    let user = getUser(prefix + ctx.from.id);
    
    ctx.reply('Tokens cost 1,000 naira for 10.\n\nInitializing payment:');

    ctx.reply('Please enter your e-mail address:');
    bot.on('message', async (ctx) => {
        updateUser(user.id, { email: ctx.message.text.trim() });
        const payment = await paymentsRouter.createPayment(user.id);
    });
});

bot.on('message', async (ctx) => {
    let user = getUser(prefix + ctx.from.id);
    if (!user) {
        addUser({
            id: prefix + ctx.from.id,
            name: ctx.from.first_name,
            tokens: 25
        });
        user = getUser(prefix + ctx.from.id);
        ctx.reply(walkThru(user.tokens));
    };
    if (user.tokens < 1) {
        return ctx.reply('You have no tokens left. Send /payments to top up.');
    };

    try {
        await ctx.reply('Thinking *');
        const claudeAnswer = await askClaude(user, ctx.message.text);
        if (claudeAnswer) ctx.reply(claudeAnswer);
        
        updateUser(user.id, { tokens: user.tokens - 1 });
    } catch (error) {
        console.error('Error processing message:', error);

        ctx.reply('Sorry, there was an error processing your request. Please try again.');
        updateUser(user.id, { tokens: user.tokens + 1 });
    };
});

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    };

    try {
        await bot.handleUpdate(req.body, res);
        res.status(200).end();
    } catch (error) {
        console.error('Error handling telegram update:', error);
        res.status(500).json({ error: 'Internal server error' });
    };
};

export const tg = { router, bot };