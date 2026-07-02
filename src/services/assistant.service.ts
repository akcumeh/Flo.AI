import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import * as userRepo from '../repositories/user.repository.js';
import * as convoRepo from '../repositories/conversation.repository.js';
import * as streakService from './streak.service.js';
import { UserNotFoundError, ClaudeTimeoutError } from '../utils/errors.js';
import type {
    MessageContent,
    ConversationMessage,
    SessionFile,
    ExamQuestion,
} from '../types/index.js';

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
    PREP: 'claude-sonnet-4-6',
} as const;

// Files API beta header — required on any messages call that references an
// uploaded file by file_id, and on the files upload/delete calls themselves.
const FILES_BETA = 'files-api-2025-04-14';

// 1-hour cache TTL: writes cost 2x (vs 1.25x for the 5-min default) but survive
// the sparse-traffic gaps between student messages and across a whole prep quiz.
const CACHE_1H = { type: 'ephemeral', ttl: '1h' } as const;

// Prep explanations can run long (the per-question teaching answer). Give the
// prep calls a generous output budget separate from the chat path.
const PREP_MAX_TOKENS = 8192;

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

<single_question_rule priority="high">
If a user sends a document or image and asks you to generate multiple questions from it (for example "make 10 questions from this") while you are NOT inside a prep session, generate exactly ONE sample question from the material, then tell them to send /prep to run a full, scored quiz built from their uploads. Never produce a batch of questions in normal chat. This protects the prep feature and points users to it.
</single_question_rule>

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

// Multi-turn cache breakpoint: marking the last content block of the newest turn
// lets the next request read the entire prior conversation (tools + system +
// history) from cache instead of re-billing it at full input price.
function tagCacheBreakpoint(messages: ClaudeMessage[]): ClaudeMessage[] {
    const last = messages[messages.length - 1];
    if (!last) return messages;
    if (typeof last.content === 'string') {
        last.content = [{ type: 'text', text: last.content, cache_control: CACHE_1H }];
    } else if (last.content.length > 0) {
        (last.content[last.content.length - 1] as Record<string, unknown>)['cache_control'] = CACHE_1H;
    }
    return messages;
}

async function callClaude(messages: ClaudeMessage[], withAttachment = false): Promise<string> {
    tagCacheBreakpoint(messages);
    // Server tool version strings and the adaptive thinking / output_config params
    // may lead the SDK's published types; cast the params object only. The response
    // is fully typed (Anthropic.Message) so block extraction stays type-safe.
    const params = {
        model: MODELS.GENERAL_1,
        max_tokens: 16384,
        thinking: { type: 'adaptive' },
        output_config: { effort: withAttachment ? 'medium' : 'low' },
        system: [{ type: 'text', text: systemPrompt, cache_control: CACHE_1H }],
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

/* ===================== Prep ===================== */

const prepSystemPrompt = `You are Florence*, running a scored quiz built strictly from the student's uploaded materials.

<critical_writing_rule priority="highest">
NEVER use an em dash. Use a comma, a colon, parentheses, or two sentences instead. A response containing an em dash is a failed response.
</critical_writing_rule>

<grounding priority="highest">
The uploaded files are the primary source of truth. Build questions only from their content, and when explaining an answer, prioritize the file over your own general knowledge.
Use your own knowledge to support and disambiguate, not to override the file. Only when the file's content is unclear or blatantly incorrect should you briefly flag the discrepancy. This is disambiguation, not reflexively second-guessing the file.
Record which file (or image) each question came from so explanations can cite it. For images there is no filename, so refer to them generically (for example "one of the images you sent").
</grounding>

<explanations>
After a student answers, explain that question clearly and student-friendly: state the correct (or all valid) answers, and explain why the student's answer was wrong, or if right, whether and how it could be improved. Keep it focused; do not pad.
</explanations>`;

// Minimal shape of the beta message response blocks we read. Avoids depending on
// exact SDK beta type-export paths while staying type-safe at the read sites.
interface BetaBlock {
    type: string;
    text?: string;
    name?: string;
    input?: unknown;
}
interface BetaMessageLike {
    content: BetaBlock[];
    stop_reason: string | null;
}

// Build the file-reference content blocks for a prep call. Images must be
// referenced as image blocks, PDFs/other docs as document blocks.
// The last block carries the cache breakpoint: prepSystemPrompt alone is under
// Sonnet's 2048-token cache minimum, so caching through the file blocks is what
// actually lets the generate + per-question calls share a prefix.
function buildFileBlocks(files: SessionFile[]): object[] {
    const blocks: Record<string, unknown>[] = files.map((f) =>
        f.kind === 'image'
            ? { type: 'image', source: { type: 'file', file_id: f.anthropicFileId } }
            : { type: 'document', source: { type: 'file', file_id: f.anthropicFileId } }
    );
    const last = blocks[blocks.length - 1];
    if (last) last['cache_control'] = CACHE_1H;
    return blocks;
}

// One prep-tier Claude call (sonnet, high effort, files beta), deadline-guarded.
async function prepCreate(params: Record<string, unknown>): Promise<BetaMessageLike> {
    const deadline = Date.now() + CLAUDE_DEADLINE_MS;
    const { system, ...rest } = params;
    const full = {
        model: MODELS.PREP,
        max_tokens: PREP_MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        betas: [FILES_BETA],
        system:
            typeof system === 'string'
                ? [{ type: 'text', text: system, cache_control: CACHE_1H }]
                : system,
        ...rest,
    };
    const res = (await withDeadline(
        anthropic.beta.messages.create(full as never) as Promise<BetaMessageLike>,
        deadline - Date.now()
    )) as BetaMessageLike;
    return res;
}

function joinText(blocks: BetaBlock[]): string {
    return blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('')
        .trim();
}

// Upload a file's bytes to the Anthropic Files API once; reference by the returned
// file_id on every later prep call instead of re-sending base64.
export async function uploadPrepFile(
    buffer: Buffer,
    fileName: string,
    mimeType: string
): Promise<string> {
    const uploaded = await anthropic.beta.files.upload({
        file: await toFile(buffer, fileName, { type: mimeType }),
        betas: [FILES_BETA],
    });
    return uploaded.id;
}

// Release an Anthropic-stored file (on /exit or session sweep). Best-effort.
export async function deletePrepFile(fileId: string): Promise<void> {
    try {
        await anthropic.beta.files.delete(fileId, { betas: [FILES_BETA] });
    } catch (err) {
        console.error('Failed to delete Anthropic file', fileId, (err as Error).message);
    }
}

const EMIT_QUESTIONS_TOOL = {
    name: 'emit_questions',
    description: 'Return the generated quiz questions as structured data.',
    input_schema: {
        type: 'object',
        properties: {
            questions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        type: { type: 'string', enum: ['mcq', 'theory', 'short'] },
                        question: { type: 'string' },
                        options: { type: 'array', items: { type: 'string' } },
                        answer: { type: 'string' },
                        marks: { type: 'number' },
                        difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
                        topic: { type: 'string' },
                        sourceLabel: { type: 'string' },
                    },
                    required: ['type', 'question', 'answer', 'marks', 'difficulty', 'topic', 'sourceLabel'],
                },
            },
        },
        required: ['questions'],
    },
};

const GRADE_ANSWER_TOOL = {
    name: 'grade_answer',
    description: 'Grade the student answer and return a teaching explanation.',
    input_schema: {
        type: 'object',
        properties: {
            correct: { type: 'boolean' },
            awardedMarks: { type: 'number' },
            explanation: { type: 'string' },
        },
        required: ['correct', 'awardedMarks', 'explanation'],
    },
};

// Generate `count` questions grounded in the uploaded files. Returns the parsed,
// sanitized question list. `count` should already be balance-gated by the caller.
export async function generateQuestions(files: SessionFile[], count: number): Promise<ExamQuestion[]> {
    const instruction = `Generate exactly ${count} exam question${count === 1 ? '' : 's'} based strictly on the uploaded materials.
Mix question types sensibly (mcq, theory, short) for the material. For every mcq, provide 4 plausible options and set "answer" to the full text of the correct option. For theory/short questions, set "answer" to a concise model answer.
For each question, set "sourceLabel" to the file it came from (use the document's title/filename, or "one of the images you sent" for image sources).
Return the questions via the emit_questions tool only.`;

    const messages = [
        {
            role: 'user',
            content: [...buildFileBlocks(files), { type: 'text', text: instruction }],
        },
    ];

    const res = await prepCreate({
        system: prepSystemPrompt,
        tools: [EMIT_QUESTIONS_TOOL],
        tool_choice: { type: 'tool', name: 'emit_questions' },
        messages,
    });

    const toolBlock = res.content.find((b) => b.type === 'tool_use' && b.name === 'emit_questions');
    const raw = (toolBlock?.input as { questions?: unknown[] } | undefined)?.questions;
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('Question generation returned no questions');
    }

    const questions: ExamQuestion[] = raw.slice(0, count).map((q) => {
        const item = q as Partial<ExamQuestion>;
        const type: ExamQuestion['type'] =
            item.type === 'mcq' || item.type === 'theory' || item.type === 'short' ? item.type : 'short';
        return {
            type,
            question: String(item.question ?? '').trim(),
            options: type === 'mcq' && Array.isArray(item.options) ? item.options.map(String) : undefined,
            answer: String(item.answer ?? '').trim(),
            marks: typeof item.marks === 'number' && item.marks > 0 ? item.marks : 1,
            difficulty:
                item.difficulty === 'easy' || item.difficulty === 'medium' || item.difficulty === 'hard'
                    ? item.difficulty
                    : 'medium',
            topic: String(item.topic ?? '').trim(),
            sourceLabel: String(item.sourceLabel ?? 'your uploaded material').trim(),
        };
    });

    return questions.filter((q) => q.question.length > 0);
}

// Per-question grade + teaching explanation for theory/short answers (one call
// does both, file context primary). MCQs are graded locally; see explainMcq.
export async function gradeAndExplain(
    files: SessionFile[],
    question: ExamQuestion,
    userAnswer: string
): Promise<{ correct: boolean; awardedMarks: number; explanation: string }> {
    const instruction = `Here is a quiz question you generated from the uploaded materials:

Question: ${question.question}
This question is worth ${question.marks} mark${question.marks === 1 ? '' : 's'}.
A model answer is: ${question.answer}
It was drawn from: ${question.sourceLabel}

The student answered:
"""${userAnswer}"""

Grade the student's answer against the file content (primary source of truth). Award between 0 and ${question.marks} marks. Then write a clear explanation that names the source, gives the correct answer, and explains why the student's answer was right or wrong (and how it could be improved). Return everything via the grade_answer tool only.`;

    const messages = [
        {
            role: 'user',
            content: [...buildFileBlocks(files), { type: 'text', text: instruction }],
        },
    ];

    const res = await prepCreate({
        system: prepSystemPrompt,
        tools: [GRADE_ANSWER_TOOL],
        tool_choice: { type: 'tool', name: 'grade_answer' },
        messages,
    });

    const toolBlock = res.content.find((b) => b.type === 'tool_use' && b.name === 'grade_answer');
    const out = toolBlock?.input as
        | { correct?: boolean; awardedMarks?: number; explanation?: string }
        | undefined;
    if (!out) throw new Error('Grading returned no result');

    const awardedMarks =
        typeof out.awardedMarks === 'number' ? Math.max(0, Math.min(question.marks, out.awardedMarks)) : 0;
    return {
        correct: Boolean(out.correct),
        awardedMarks,
        explanation: String(out.explanation ?? '').trim() || 'No explanation available.',
    };
}

// Teaching explanation for an MCQ that was graded locally. Returns prose only.
export async function explainMcq(
    files: SessionFile[],
    question: ExamQuestion,
    userAnswer: string,
    correct: boolean
): Promise<string> {
    const instruction = `Here is a multiple-choice question you generated from the uploaded materials:

Question: ${question.question}
Options: ${(question.options ?? []).join(' | ')}
Correct answer: ${question.answer}
It was drawn from: ${question.sourceLabel}

The student chose: "${userAnswer}", which was ${correct ? 'correct' : 'incorrect'}.

Write a short explanation that names the source, confirms the correct answer, and explains why it is correct (and, if the student was wrong, why their choice was not). Respond with the explanation text only, no tool call.`;

    const messages = [
        {
            role: 'user',
            content: [...buildFileBlocks(files), { type: 'text', text: instruction }],
        },
    ];

    const res = await prepCreate({ system: prepSystemPrompt, messages });
    return joinText(res.content) || 'No explanation available.';
}
