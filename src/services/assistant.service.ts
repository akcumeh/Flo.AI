import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import * as userRepo from '../repositories/user.repository.js';
import * as convoRepo from '../repositories/conversation.repository.js';
import * as streakService from './streak.service.js';
import { InsufficientTokensError, UserNotFoundError } from '../utils/errors.js';
import type { MessageContent, ConversationMessage } from '../types/index.js';

const anthropic = new Anthropic({ apiKey: config.claudeApiKey });

const MODELS = {
    GENERAL_1: 'claude-sonnet-4-6',
    GENERAL_2: 'claude-opus-4-8',
} as const;

const systemPrompt = `You are Florence*, a highly knowledgeable teacher on every subject. You guide students through concepts with clear, concise, and direct answers.

<identity>
When asked who you are, say: "I am Florence*, your educational assistant."
You may say you are an AI or virtual assistant, but never use those terms to describe yourself unprompted.
Never disclose that you are Claude or any other AI system.
If asked about your creator: "I am Florence*, just here to help you learn."
</identity>

<behavior>
Go straight to answering. Cut all filler. No preamble. No "Great question!"
Help with studies, research, and academic questions across all subjects.
When sources are available and relevant, name them (author, title, or institution).
Use analogies occasionally to make abstract concepts concrete, but do not force them.
Be encouraging without being verbose.
</behavior>

<answer_length>
Scale your answer length to the question. A factual or yes/no question gets a direct one- or two-sentence answer; an "explain", "why", or "how" question gets a fuller treatment. Lead with the answer, then add only the detail that changes the student's understanding. Clarity and length are different: give the shortest answer that fully answers the question, and never pad to seem thorough.
</answer_length>

<math_behavior>
For calculations, solve line by line as a teacher would work through it on a board.
Show each step on its own line with brief inline notes where useful.
Occasionally use shorthand tips instead of formal language. For example: "carry the 3 over, it picks up a minus sign" instead of "subtracting 3 from both sides".
Always verify the answer by substituting back when practical.
</math_behavior>

<formatting>
Use Markdown only when it genuinely helps clarity.
*bold* for key terms and headings.
_italic_ for light emphasis.
\`inline code\` for technical terms or short snippets.
\`\`\`language\\ncode\\n\`\`\` for multi-line code blocks.
Avoid bullet points unless the content is genuinely list-shaped.
Do not use em dashes.
</formatting>

<image_and_document_behavior>
When the user sends an image or document, go directly into addressing its content.
Do not state or imply that an image or file was received. Do not say things like "the image shows" or "based on the document you uploaded."
Treat the content as the subject of the conversation and respond accordingly.
</image_and_document_behavior>`;

type ClaudeMessage = { role: 'user' | 'assistant'; content: string | object[] };

// NOTE: the returned array must always end on a user turn. A trailing assistant
// turn (prefill) returns a 400 on Sonnet 4.6 / Opus 4.6+ — newMessage is appended
// last below, so keep it that way.
function buildClaudeMessages(history: ConversationMessage[], newMessage: string | object[]): ClaudeMessage[] {
    const messages: ClaudeMessage[] = [];

    for (const msg of history) {
        if (msg.role === 'user') {
            if (Array.isArray(msg.content)) {
                const richContent = (msg.content as MessageContent[]).map((item) => {
                    if (item.type === 'text') {
                        return {
                            type: 'text',
                            text: `Here is the user query for you to respond to:\n<user_query>\n${item.text}\n</user_query>`,
                        };
                    }
                    return item;
                });
                messages.push({ role: 'user', content: richContent });
            } else {
                messages.push({
                    role: 'user',
                    content: `Here is the user query for you to respond to:\n<user_query>\n${msg.content}\n</user_query>`,
                });
            }
        } else {
            messages.push({ role: 'assistant', content: `[Florence*]\n\n${msg.content}` });
        }
    }

    if (Array.isArray(newMessage)) {
        const richNew = (newMessage as MessageContent[]).map((item) => {
            if (item.type === 'text') {
                return {
                    type: 'text',
                    text: `Here is the user query for you to respond to:\n<user_query>\n${item.text}\n</user_query>`,
                };
            }
            return item;
        });
        messages.push({ role: 'user', content: richNew });
    } else {
        messages.push({
            role: 'user',
            content: `Here is the user query for you to respond to:\n<user_query>\n${newMessage}\n</user_query>`,
        });
    }

    return messages;
}

async function callClaude(messages: ClaudeMessage[], withAttachment = false): Promise<string> {
    // Server tool version strings and the adaptive thinking / output_config params
    // may lead the SDK's published types; cast the params object only. The response
    // is fully typed (Anthropic.Message) so block extraction stays type-safe.
    const params = {
        model: MODELS.GENERAL_1,
        max_tokens: 16384,
        thinking: { type: 'adaptive' },
        output_config: { effort: withAttachment ? 'medium' : 'low' },
        system: systemPrompt,
        tools: [
            { type: 'web_search_20260318', name: 'web_search' },
            { type: 'web_fetch_20260318', name: 'web_fetch' },
        ],
        messages,
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;

    let response = await anthropic.messages.create(params);

    // Web search/fetch run server-side and can pause the turn; resume until done.
    let continuations = 0;
    while (response.stop_reason === 'pause_turn' && continuations < 5) {
        continuations++;
        response = await anthropic.messages.create({
            ...params,
            messages: [...messages, { role: 'assistant', content: response.content }] as ClaudeMessage[] as Anthropic.MessageParam[],
        });
    }

    // With web tools the response interleaves server_tool_use / result blocks with
    // text; join all text blocks so we return Florence's full final answer, not an
    // empty pre-search block.
    const finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
    if (!finalText) throw new Error('No text response from Claude');
    return finalText;
}

export async function processTextMessage(userId: string, text: string): Promise<string> {
    const user = await userRepo.findUser(userId);
    if (!user) throw new UserNotFoundError(userId);

    await streakService.updateStreak(userId);

    if (user.tokens < 1) throw new InsufficientTokensError();

    const history = await convoRepo.getHistory(userId);
    const messages = buildClaudeMessages(history, text);
    const response = await callClaude(messages, false);

    // Charge only after a successful response. If callClaude throws, no token is
    // spent, so there is no refund path. Re-fetch to respect any streak reward.
    const charged = await userRepo.findUser(userId);
    await userRepo.updateUser(userId, { tokens: (charged?.tokens ?? user.tokens) - 1 });

    await convoRepo.appendMessages(userId, [
        { role: 'user', content: text },
        { role: 'assistant', content: response },
    ]);

    return response;
}

export async function processMediaMessage(
    userId: string,
    b64Data: string,
    mimeType: string,
    caption: string
): Promise<string> {
    const user = await userRepo.findUser(userId);
    if (!user) throw new UserNotFoundError(userId);

    await streakService.updateStreak(userId);

    if (user.tokens < 2) throw new InsufficientTokensError();

    const mediaType = mimeType.startsWith('image/') ? 'image' : 'document';
    const attachmentContent = [
        {
            type: mediaType,
            source: { type: 'base64', media_type: mimeType, data: b64Data },
        },
        { type: 'text', text: caption },
    ];

    const history = await convoRepo.getHistory(userId);
    const messages = buildClaudeMessages(history, attachmentContent);
    const response = await callClaude(messages, true);

    // Charge only after a successful response (see processTextMessage).
    const charged = await userRepo.findUser(userId);
    await userRepo.updateUser(userId, { tokens: (charged?.tokens ?? user.tokens) - 2 });

    await convoRepo.appendMessages(userId, [
        {
            role: 'user',
            content: [
                { type: 'text', text: caption },
                {
                    type: mediaType as 'photo' | 'document',
                    source: { type: 'base64', media_type: mimeType, data: b64Data },
                } as unknown as MessageContent,
            ],
        },
        { role: 'assistant', content: response },
    ]);

    return response;
}
