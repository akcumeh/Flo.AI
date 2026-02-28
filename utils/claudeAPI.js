import Anthropic from "@anthropic-ai/sdk";
import dotenv from 'dotenv';

dotenv.config();

const anthropic = new Anthropic({
    apiKey: process.env.CLAUDE_API_KEY
});

export const MODELS = {
    GENERAL_1: "claude-sonnet-4-6",
    GENERAL_2: "claude-opus-4-6",
};

const systemPrompt = `You are Florence*, a highly knowledgeable teacher on every subject. You guide students through concepts with clear, concise, and direct answers.

<identity>
When asked who you are, say: "I am Florence, your educational assistant."
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
\`\`\`language\ncode\n\`\`\` for multi-line code blocks.
Avoid bullet points unless the content is genuinely list-shaped.
Do NOT use em dashes.
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

const MODEL_CONFIGS = {
    [MODELS.GENERAL_1]: {
        maxTokens: 16384,
        systemPrompt,
    },
    [MODELS.GENERAL_2]: {
        maxTokens: 16384,
        systemPrompt,
    },
};
/**
 * Format messages for Claude API with character reinforcement
 * @param {Array} conversationHistory - Raw conversation history from user data
 * @param {string|Array} newUserMessage - New message from user (string for text, array for media)
 * @returns {Array} - Formatted messages for Claude API
 */
export function formatMessagesForClaude(conversationHistory, newUserMessage) {
    const formattedMessages = [];

    if (conversationHistory && conversationHistory.length > 0) {
        conversationHistory.forEach(msg => {
            if (msg.role === 'user') {
                if (Array.isArray(msg.content)) {
                    // Handle media messages from history
                    const richContent = msg.content.map(item => {
                        if (item.type === 'text') {
                            return {
                                type: 'text',
                                text: `Here is the user query for you to respond to:\n<user_query>\n${item.text}\n</user_query>`
                            };
                        }
                        return item; // Pass media objects as-is
                    });
                    formattedMessages.push({ role: 'user', content: richContent });
                } else {
                    // Handle simple text messages from history
                    formattedMessages.push({
                        role: 'user',
                        content: `Here is the user query for you to respond to:\n<user_query>\n${msg.content}\n</user_query>`
                    });
                }
            } else if (msg.role === 'assistant') {
                formattedMessages.push({
                    role: 'assistant',
                    content: `[Florence*]\n\n${msg.content}`
                });
            }
        });
    }

    // Handle the new user message
    if (Array.isArray(newUserMessage)) {
        // New message is a media message
        const richNewMessage = newUserMessage.map(item => {
            if (item.type === 'text') {
                return {
                    type: 'text',
                    text: `Here is the user query for you to respond to:\n<user_query>\n${item.text}\n</user_query>`
                };
            }
            return item;
        });
        formattedMessages.push({ role: 'user', content: richNewMessage });
    } else {
        // New message is a simple text message
        formattedMessages.push({
            role: 'user',
            content: `Here is the user query for you to respond to:\n<user_query>\n${newUserMessage}\n</user_query>`
        });
    }

    return formattedMessages;
};

/**
 * Send a text-only message to Claude
 * @param {Array} messages - Conversation history in Claude format
 * @param {string} modelType - Model type from MODELS constant (default: GENERAL_1)
 * @param {string} systemPrompt - Optional system prompt override
 * @returns {Promise<string>} - Claude's response
 */
export async function sendTextMessage(messages, modelType = MODELS.GENERAL_1, systemPrompt) {
    try {
        const config = MODEL_CONFIGS[modelType] || MODEL_CONFIGS[MODELS.GENERAL_1];

        const response = await anthropic.messages.create({
            model: modelType,
            max_tokens: config.maxTokens,
            thinking: { type: "enabled", budget_tokens: 8000 },
            output_config: { effort: "low" },
            system: systemPrompt || config.systemPrompt,
            messages,
        });

        const textBlock = response.content.find(block => block.type === 'text');
        if (!textBlock) throw new Error("No text response from Claude API");

        return textBlock.text;
    } catch (error) {
        console.error(`Error sending message.`, error);
        throw error;
    }
}

export async function sendMessageWithAttachment(messages, modelType = MODELS.GENERAL_1, systemPrompt) {
    try {
        const config = MODEL_CONFIGS[modelType] || MODEL_CONFIGS[MODELS.GENERAL_1];

        const response = await anthropic.messages.create({
            model: modelType,
            max_tokens: config.maxTokens,
            thinking: { type: "enabled", budget_tokens: 8000 },
            output_config: { effort: "medium" },
            system: systemPrompt || config.systemPrompt,
            messages,
        });

        const textBlock = response.content.find(block => block.type === 'text');
        if (!textBlock) throw new Error("No text response from Claude API");

        return textBlock.text;
    } catch (error) {
        console.error(`Error sending message with attachment.`, error);
        throw error;
    }
}

export async function sendSkillsMessage(messages, skillId) {
    const skillMap = {
        xlsx: { id: 'xlsx', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        pptx: { id: 'pptx', ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
        docx: { id: 'docx', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        pdf:  { id: 'pdf',  ext: 'pdf',  mime: 'application/pdf' }
    };

    const skill = skillMap[skillId] || skillMap.pdf;

    const response = await anthropic.beta.messages.create({
        model: MODELS.GENERAL_1,
        max_tokens: 4096,
        betas: ['code-execution-2025-08-25', 'skills-2025-10-02'],
        container: {
            skills: [{ type: 'anthropic', skill_id: skill.id, version: 'latest' }]
        },
        tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
        system: systemPrompt,
        messages
    });

    let fileId = null;
    for (const block of response.content) {
        if (block.type === 'tool_use' && block.name === 'code_execution') {
            for (const resultBlock of block.content ?? []) {
                if (resultBlock.file_id) {
                    fileId = resultBlock.file_id;
                    break;
                }
            }
        }
        if (fileId) break;
    }

    const textBlock = response.content.find(b => b.type === 'text');
    const textResponse = textBlock ? textBlock.text : 'Your document is ready.';

    let fileBuffer = null;
    if (fileId) {
        const fileContent = await anthropic.beta.files.download(fileId, {
            betas: ['files-api-2025-04-14']
        });
        const chunks = [];
        for await (const chunk of fileContent) {
            chunks.push(chunk);
        }
        fileBuffer = Buffer.concat(chunks);
    }

    return { text: textResponse, fileBuffer, ext: skill.ext, mime: skill.mime, fileId };
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
        console.warn(`Unsupported MIME type: ${fileType[1]}. Defaulting to image/jpeg.`);
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