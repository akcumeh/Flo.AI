
import express from 'express';
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';

dotenv.config();

const router = express.Router();

import {
    addUser,
    getUser,
    askClaude,
    walkThru
} from './utils.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const prefix = 'tg:';

bot.command('start', ctx => {
    let user = getUser(prefix + ctx.from.id);
    if (!user) {
        addUser({
            id: prefix + ctx.from.id,
            name: ctx.from.first_name,
            tokens: 25
        });
        ctx.reply(walkThru(user.tokens));
    };
    
    return ctx.reply(`Hello ${ctx.from.first_name}, welcome to Florence*! What do you need help with today?\n\nYou have ${user.tokens} tokens.`);
});

bot.command('about', (ctx) => {
    ctx.reply('Florence* is the educational assistant at your fingertps. More about Florence*. <link>.');
});

bot.command('tokens', (ctx) => {
    let user = getUser(prefix + ctx.from.id);
    ctx.reply(`You have ${user.tokens} tokens. To top up, send /payments.`);
});

bot.command('payments', (ctx) => {
    let user = getUser(prefix + ctx.from.id);
    //payment logic
});

bot.on('message', async (ctx) => {
    let user = getUser(prefix + ctx.from.id);
    if (!user) {
        addUser({
            id: prefix + ctx.from.id,
            name: ctx.from.first_name,
            tokens: 25
        });
        ctx.reply(walkThru(user.tokens));
    };
    if (user.tokens < 1) {
        return ctx.reply('You have no tokens left. Send /payments to top up.');
    };

    try {
        await ctx.reply('Thinking *');
        const claudeAnswer = await askClaude(user, ctx.message.text);
        if (claudeAnswer) ctx.reply(claudeAnswer);
        
        user.tokens -= 1;
    } catch (error) {
        console.error('Error processing message:', error);

        ctx.reply('Sorry, there was an error processing your request. Please try again.');
        user.tokens += 1;
    };
});

router.post('/', async (req, res) => {
    bot.handleUpdate(req.body, res);
});

export const tg = { router, bot };