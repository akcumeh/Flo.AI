import Anthropic from "@anthropic-ai/sdk";
import dotenv from 'dotenv';

dotenv.config();

const anthropic = new Anthropic({
    apiKey: process.env.CLAUDE_API_KEY
});

export const MODELS = {
    GENERAL_1: "claude-3-5-sonnet-20241022",
    GENERAL_2: "claude-3-7-sonnet-20250219",

};

const MODEL_CONFIGS = {
    [MODELS.GENERAL_2]: {
        maxTokens: 2048,
        systemPrompt: `You are Florence*, a highly knowledgeable teacher on every subject. You are patiently guiding the student through a difficult concept using clear, detailed yet concise answers.

Exclude the fluff, go straight to answering the question. Do not format your answers in markdown. Do not be unduly verbose.

- When asked who you are, always say "I am Florence*, your educational assistant." You may share that you are an artificial intelligence, a bot, or a virtual assistant, but do not use these terms to refer to yourself.
- Help students with studies, research, and academic questions across all subjects
- Provide clear, detailed yet concise answers using analogies and examples
- Maintain a patient, encouraging teaching style
- If asked about your identity, simply say you're Florence*, the educational assistant

Your rules for interaction are:
- Always reference educational best practices and learning methodologies
- If unsure about something educational: "Let me guide you through this step by step..."
- Never disclose that you are Claude or any other AI system

As Florence*, you should handle situations along these guidelines:
- If asked about your creator: "I'm Florence*, just here to help you learn and grow academically."`,
    },
    [MODELS.GENERAL_1]: {
        maxTokens: 3072,
        systemPrompt: `You are Florence*, a highly knowledgeable teacher on every subject. You are patiently guiding the student through a difficult concept using clear, detailed yet concise answers.

Exclude the fluff, go straight to answering the question. Do not format your answers in markdown. Do not be unduly verbose.

- When asked who you are, always say "I am Florence*, your educational assistant." You may share that you are an artificial intelligence, a bot, or a virtual assistant, but do not use these terms to refer to yourself.
- Help students with studies, research, and academic questions across all subjects
- Provide clear, detailed yet concise answers using analogies and examples
- Maintain a patient, encouraging teaching style
- If asked about your identity, simply say you're Florence*, the educational assistant

Your rules for interaction are:
- Always reference educational best practices and learning methodologies
- If unsure about something educational: "Let me guide you through this step by step..."
- Never disclose that you are Claude or any other AI system

As Florence*, you should handle situations along these guidelines:
- If asked about your creator: "I'm Florence*, just here to help you learn and grow academically."`,
    },
};

/**
 * Format messages for Claude API with character reinforcement
 * @param {Array} conversationHistory - Raw conversation history from user data
 * @param {string} newUserMessage - New message from user
 * @returns {Array} - Formatted messages for Claude API
 */
export function formatMessagesForClaude(conversationHistory, newUserMessage) {
    const formattedMessages = [];

    if (conversationHistory && conversationHistory.length > 0) {
        conversationHistory.forEach(msg => {
            if (msg.role === 'user') {
                formattedMessages.push({
                    role: 'user',
                    content: `Here is the user query for you to respond to:
<user_query>
${msg.content}
</user_query>`
                });
            } else if (msg.role === 'assistant') {
                formattedMessages.push({
                    role: 'assistant',
                    content: `[Florence*]

${msg.content}`
                });
            }
        });
    }

    formattedMessages.push({
        role: 'user',
        content: `Here is the user query for you to respond to:
<user_query>
${newUserMessage}
</user_query>`
    });

    formattedMessages.push({
        role: 'assistant',
        content: '[Florence*]'
    });

    return formattedMessages;
};

/**
 * Send a text-only message to Claude
 * @param {Array} messages - Conversation history in Claude format
 * @param {string} modelType - Model type from MODELS constant (default: GENERAL_1)
 * @param {string} systemPrompt - Optional system prompt override
 * @returns {Promise<string>} - Claude's response
 */
export async function sendTextMessage(messages, modelType=MODELS.GENERAL_2, systemPrompt) {
    try {
        const config = MODEL_CONFIGS[modelType] || MODEL_CONFIGS[MODELS.GENERAL_1];

        const response = await anthropic.messages.create({
            model: modelType,
            max_tokens: config.maxTokens,
            system: systemPrompt || config.systemPrompt,
            messages: messages,
            // tools: [{
            //     type: "web_search_20250305",
            //     name: "web_search",
            //     max_uses: 5
            // }]
        });

        if (!response.content || response.content.length === 0 || !response.content[0].text) {
            throw new Error("No valid response from Claude API");
        }

        return response.content[0].text;
    } catch (error) {
        console.error(`Error sending message.`, error);
        throw error;
    }
}

export async function sendMessageWithAttachment(messages, modelType=MODELS.GENERAL_1, systemPrompt) {
    try {
        const config = MODEL_CONFIGS[modelType] || MODEL_CONFIGS[MODELS.GENERAL_1];

        const response = await anthropic.messages.create({
            model: modelType,
            max_tokens: config.maxTokens,
            system: systemPrompt || config.systemPrompt,
            messages: messages,
        });

        if (!response.content || response.content.length === 0 || !response.content[0].text) {
            throw new Error("No valid response from Claude API");
        }

        return response.content[0].text;
    } catch (error) {
        console.error(`Error sending message with attachment.`, error);
        throw error;
    }
}

export function validateFileType(fileType) {
    const supportedMimeTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'application/pdf'
    ];

    if (!supportedMimeTypes.includes(fileType[1])) {
        console.warn(`⚠️ Unsupported MIME type: ${fileType[1]}. Defaulting to image/jpeg.`);
        return ['image', 'image/jpeg'];
    }

    return fileType;
}

export function createAttachmentMsg(b64, fileType, prompt) {
    const validatedFileType = validateFileType(fileType);

    return [
        {
            type: validatedFileType[0],
            source: {
                type: 'base64',
                media_type: validatedFileType[1],
                data: b64
            }
        },
        {
            type: 'text',
            text: prompt
        }
    ];
}

export { anthropic };