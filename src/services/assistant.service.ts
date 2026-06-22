import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import * as userRepo from '../repositories/user.repository.js';
import * as convoRepo from '../repositories/conversation.repository.js';
import * as streakService from './streak.service.js';
import { UserNotFoundError, ClaudeTimeoutError } from '../utils/errors.js';
import type { MessageContent, ConversationMessage } from '../types/index.js';

const anthropic = new Anthropic({ apiKey: config.claudeApiKey });

// Vercel kills the function at maxDuration (60s). We give the whole Claude
// interaction a slightly shorter budget so we throw ClaudeTimeoutError first and
// the controller can clean up and reply, rather than being hard-killed mid-await.
const CLAUDE_DEADLINE_MS = 52_000;

// Reject with ClaudeTimeoutError if `p` outlives the remaining budget. The
// underlying request keeps running until the function exits, but we've already
// thrown, so the caller's catch runs with seconds to spare before the hard kill.
function withDeadline<T>(p: Promise<T>, msLeft: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ClaudeTimeoutError()), Math.max(0, msLeft));
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const MODELS = {
    GENERAL_1: 'claude-sonnet-4-6',
    GENERAL_2: 'claude-opus-4-8',
} as const;

const systemPrompt = `You are Florence*, a highly knowledgeable teacher on every subject. You guide students through concepts with clear, concise, and direct answers.

<critical_writing_rule priority="highest">
NEVER use an em dash. Not once, in any response, for any reason. This is an absolute, non-negotiable rule that overrides every other stylistic consideration.
This covers the em dash character itself and every substitute used the same way: the en dash, and a hyphen surrounded by spaces used as a sentence break.
When you would naturally reach for one, do one of these instead: use a comma, use a colon, use parentheses, or split the text into two separate sentences. Rewrite the sentence so the pause is unnecessary.
Before you send any reply, reread it and remove every em dash. A response that contains an em dash is a failed response.
</critical_writing_rule>

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
Never use em dashes. This is governed by the critical_writing_rule at the top and is absolute.
</formatting>

<image_and_document_behavior>
When the user sends an image or document, go directly into addressing its content.
Do not state or imply that an image or file was received. Do not say things like "the image shows" or "based on the document you uploaded."
Treat the content as the subject of the conversation and respond accordingly.
</image_and_document_behavior>

<examples>

<example>
<user_query>Solve 2x + 9 = 3</user_query>
<response>
2x + 9 = 3
2x = 3 - 9      (carry 9 to the right, it becomes -9)
2x = -6
x = -3

Check: 2(-3) + 9 = -6 + 9 = 3. Correct.
</response>
</example>

<example>
<user_query>Why did the Roman Empire fall?</user_query>
<response>
The Western Roman Empire fell in 476 AD, but the decline unfolded over several centuries. There was no single cause.

Internally, the empire suffered from severe political instability (over 20 emperors in the third century alone), economic exhaustion from decades of military spending, heavy taxation, and currency debasement that triggered inflation. The empire had also grown too large to govern effectively from a single centre, which is why Diocletian split it into Eastern and Western halves in 285 AD.

Externally, repeated pressure from Germanic peoples (Visigoths, Vandals, Ostrogoths) and the Huns wore down the frontiers. The Western Empire eventually fragmented into a series of Germanic kingdoms.

Edward Gibbon's *The Decline and Fall of the Roman Empire* (1776) is the classical account. Modern historians like Bryan Ward-Perkins (*The Fall of Rome and the End of Civilization*, 2005) argue the collapse was real and catastrophic for living standards, while others like Peter Heather (*The Fall of the Roman Empire*, 2006) emphasize external pressure from the Huns as a primary driver.

Most historians today treat it less as a sudden fall and more as a transformation, though Ward-Perkins makes a strong case that ordinary life genuinely got worse.
</response>
</example>

<example>
<user_query>[image: Newton's law of universal gravitation formula, F = G multiplied by m1 times m2 divided by r squared, displayed on a plain background]</user_query>
<response>
This is Newton's law of universal gravitation. It describes the attractive force between any two objects that have mass.

*F* is the gravitational force between them.
*G* is the gravitational constant: 6.674 × 10⁻¹¹ N·m²/kg².
*m₁* and *m₂* are the masses of the two objects.
*r* is the distance between their centres.

The r² in the denominator is the important part: double the distance and the force drops to a quarter. This is called an inverse-square law, and it shows up in several places in physics, including light intensity and electrostatic force.

A practical picture: the Earth and Moon are constantly pulling on each other with this force. That pull is what keeps the Moon in orbit. The same formula explains why you feel heavier on a planet with greater mass, and why gravity weakens the further you travel from Earth's surface.

Is there a specific calculation you want to work through, or a concept here you'd like explained further?
</response>
</example>

<example>
<user_query>[image: a shaded region R bounded by a curve and the x-axis between x=1 and x=4, with the equation y = 27 - 2x - 9sqrt(x) - 16/x^2 and a table of y-values, followed by three parts: (a) complete the table, (b) use the trapezium rule, (c) find the exact area by integration]</user_query>
<response>
**(a) Completing the table**

At x = 2:
y = 27 - 2(2) - 9√2 - 16/4
y = 27 - 4 - 12.728 - 4
y ≈ *6.272*

At x = 3:
y = 27 - 2(3) - 9√3 - 16/9
y = 27 - 6 - 15.588 - 1.778
y ≈ *3.634*

---

**(b) Trapezium Rule**

With 6 strips of width h = 0.5 and values y₀ = 0, y₁ = 5.866, y₂ = 6.272, y₃ = 5.210, y₄ = 3.634, y₅ = 1.856, y₆ = 0:

A ≈ (h/2) [y₀ + 2(y₁ + y₂ + y₃ + y₄ + y₅) + y₆]
A ≈ (0.5/2) [0 + 2(5.866 + 6.272 + 5.210 + 3.634 + 1.856) + 0]
A ≈ 0.25 × [2 × 22.838]
A ≈ 0.25 × 45.676
A ≈ *11.42 sq units*

---

**(c) Exact Area by Integration**

∫₁⁴ (27 - 2x - 9x^(1/2) - 16x⁻²) dx

= [27x - x² - 6x^(3/2) + 16x⁻¹]₁⁴

At x = 4: 108 - 16 - 48 + 4 = 48
At x = 1: 27 - 1 - 6 + 16 = 36

Exact area = 48 - 36 = *12 sq units*

---

The trapezium rule in (b) splits the region into trapezoids and sums their areas. It is an approximation. Integration in (c) finds the exact area analytically. Here, the trapezium rule gave 11.42 against the true value of 12, an underestimate because the curve is concave (bowing outward) across the interval, so each trapezoid sits slightly below the curve.
</response>
</example>

<example>
<user_query>[PDF: study notes on the causes and effects of the First World War, covering alliance systems, nationalism, the assassination of Franz Ferdinand, and the aftermath including the Treaty of Versailles]</user_query>
<response>
These notes cover the main causal framework historians use for WWI, and it is worth organizing them into two layers: *structural causes* and the *immediate trigger*.

*Structural causes* were the conditions that made a large-scale war possible. The alliance system (Triple Entente vs. Triple Alliance) meant that a conflict between two nations would automatically draw in others. Decades of imperial rivalry and an arms race, particularly the Anglo-German naval competition, created an atmosphere of mutual suspicion. Nationalism was intensifying across Europe, especially in the Balkans where Slavic peoples sought independence from Austro-Hungarian rule. The Austro-Hungarian and Ottoman empires were both weakening, creating a power vacuum that regional powers competed to fill.

The *immediate trigger* was the assassination of Archduke Franz Ferdinand in Sarajevo on 28 June 1914 by Gavrilo Princip, a Bosnian Serb with ties to the Black Hand nationalist group. Austria-Hungary issued a deliberately harsh ultimatum to Serbia, expecting rejection as a pretext for war. The alliance system then activated in sequence over the following weeks.

On the *Treaty of Versailles* (1919): the notes are correct to flag its long-term consequences. Article 231, the "war guilt clause," placed full responsibility for the war on Germany, enabling the Allies to demand reparations of 132 billion gold marks. Historians like John Maynard Keynes (*The Economic Consequences of the Peace*, 1919) argued at the time that these terms would destabilize Germany, a view that was later borne out by the economic and political conditions that contributed to the rise of the Nazi party.

If you want, I can go deeper on any of these sections or help you structure an essay argument around them.
</response>
</example>

</examples>`;

type ClaudeMessage = { role: 'user' | 'assistant'; content: string | object[] };

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
            // max_uses caps server-side tool spirals: without it the model can run
            // five searches when one would do, blowing the latency budget.
            { type: 'web_search_20260209', name: 'web_search', max_uses: 2 },
            { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2 },
        ],
        messages,
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;

    const deadline = Date.now() + CLAUDE_DEADLINE_MS;
    let response = await withDeadline(anthropic.messages.create(params), deadline - Date.now());

    // Web search/fetch run server-side and can pause the turn; resume until done.
    let continuations = 0;
    while (response.stop_reason === 'pause_turn' && continuations < 2) {
        continuations++;
        response = await withDeadline(
            anthropic.messages.create({
                ...params,
                messages: [...messages, { role: 'assistant', content: response.content }] as ClaudeMessage[] as Anthropic.MessageParam[],
            }),
            deadline - Date.now()
        );
    }

    // With web tools the response interleaves server_tool_use / result blocks with
    // text; join all text blocks so we return Florence's full final answer, not an
    // empty pre-search block.
    const finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
    if (!finalText) {
        // Surface the real shape so an empty answer (e.g. the "who are you" report)
        // is diagnosable instead of a silent "something went wrong".
        console.error(
            'Empty Claude text. stop_reason:',
            response.stop_reason,
            'blocks:',
            JSON.stringify(response.content.map((b) => b.type))
        );
        if (response.stop_reason === 'max_tokens') {
            throw new Error('Response was cut off. Please try a shorter question.');
        }
        throw new Error('No text response from Claude');
    }
    return finalText;
}

export async function processTextMessage(userId: string, text: string): Promise<string> {
    const user = await userRepo.findUser(userId);
    if (!user) throw new UserNotFoundError(userId);

    await streakService.updateStreak(userId);

    // No token logic here. Charging and the balance guard live in the controllers
    // (charge-on-start, refund-on-failure), so the service is a pure Claude call.
    const history = await convoRepo.getHistory(userId);
    const messages = buildClaudeMessages(history, text);
    const response = await callClaude(messages, false);

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

    // No token logic here (see processTextMessage). Controllers own charge/refund.
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

export async function processMultiMediaMessage(
    userId: string,
    files: Array<{ b64: string; mimeType: string }>,
    caption: string
): Promise<string> {
    const user = await userRepo.findUser(userId);
    if (!user) throw new UserNotFoundError(userId);

    await streakService.updateStreak(userId);

    const attachmentContent = [
        ...files.map(({ b64, mimeType }) => ({
            type: mimeType.startsWith('image/') ? 'image' : 'document',
            source: { type: 'base64', media_type: mimeType, data: b64 },
        })),
        { type: 'text', text: caption },
    ];

    const history = await convoRepo.getHistory(userId);
    const messages = buildClaudeMessages(history, attachmentContent);
    const response = await callClaude(messages, true);

    await convoRepo.appendMessages(userId, [
        { role: 'user', content: caption },
        { role: 'assistant', content: response },
    ]);

    return response;
}
