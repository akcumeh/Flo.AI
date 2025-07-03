const prefix = 'wa:';

import express from 'express';
import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

import {
    walkThru,
    
    addUser,
    getUser,
    updateUser,

    askClaude,

} from '../utils/utils.js';

const router = express.Router();

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

async function sendMsg(content, id) {
    try {
        return await client.messages.create({
            body: content,
            from: `whatsapp:+${process.env.TWILIO_PHONE_NUMBER}`,
            to: `whatsapp:+${id.substring(3)}` // remove 'wa:'
        });
    } catch (error) {
        console.error('Error sending WA message', error);
    }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    };

    try {
        let user = getUser(prefix+WaId);
        if (!user) {
            user = addUser({
                id: `${prefix}${WaId}`,
                name: ProfileName,
                tokens: 25
            });

            // notify me
            await Promise.all([
                sendMsg(`New user: ${ProfileName} (+${WaId})`, '2348164975875'),
                sendMsg(`New user: ${ProfileName} (+${WaId})`, '2348143770724')
            ]);

            await sendMsg(walkThru(user.tokens), WaId);
        };

        switch (Body) {
            case '/start':
                // Reset conversation history on /start
                user.convoHistory = [];
                return await sendMsg(
                    `Hello ${ProfileName}, welcome to Florence*! What do you need help with today?\n\n` +
                    `You have ${user.tokens} tokens.`,
                    WaId
                );

            case '/about':
                console.log('Informing the user.');
                return await sendMsg(
                    `Florence* is the educational assistant at your fingertips. More info here: <link>.`,
                    WaId
                );

            case '/payments':
                console.log('payment!');
                return await sendMsg(
                    `Tokens cost 1000 naira for 25. Make your payments here:\n\n` +
                    `https://flutterwave.com/pay/jinkrgxqambh`,
                    WaId
                );

            case '/tokens':
                if (user.tokens <= 5) {
                    await sendMsg(
                        `You are running low on tokens. Top up by sending /payments.`,
                        WaId
                    );
                };
                return await sendMsg(
                    `Hey ${ProfileName.split(' ')[0]}, you have ${user.tokens} tokens.`,
                    WaId
                );

            case '/streak':
                return await sendMsg(
                    `Hey ${ProfileName.split(' ')[0]}, you are on a ${user.streak}-day streak. Send one prompt a day to keep it going!`,
                    WaId
                );

            default:
                if (user.tokens < 1) {
                    return await sendMsg(
                        `You have run out of tokens. Top up by sending /payments.`,
                        WaId
                    );
                };

                updateUser(user.id, { tokens: user.tokens - 1 });
                let response = await askClaude(user, Body);
                return await sendMsg(response, WaId);
        };
    } catch (error) {
        console.error('Error processing command', error);
        updateUser(user.id, { tokens: user.tokens + 1 });
        res.status(500).send('Error?')
    }
};

export const wa = router;