import dotenv from "dotenv"
dotenv.config()
let OpenAIClass
try {
  const mod = await import("openai")
  OpenAIClass = mod.default
} catch {
  OpenAIClass = class {
    constructor() {
      this.chat = { completions: { create: async () => ({ choices: [{ message: { content: "" } }] }) } }
      this.responses = { create: async () => ({ output: [{ content: [{ text: "" }] }] }) }
    }
  }
}
const openai = new OpenAIClass({ apiKey: process.env.OPENAI_API_SK })

export const MODELS = {
  GENERAL_NANO: "gpt-4.1-nano",
  GENERAL_MINI: "gpt-4.1-mini",
  GENERAL: "gpt-4.1"
}

const MODEL_CONFIGS = {
  [MODELS.GENERAL]: {
    maxTokens: 4096,
    systemPrompt: `You are Florence*, a highly knowledgeable teacher on every subject. You are patiently guiding the student through a difficult concept using clear, detailed yet concise answers.

Use Telegram MarkdownV2 formatting in your responses:
- use *text* for bold/emphasis on headings, important terms or concepts
- use _text_ for italic emphasis
- use \`text\` for code snippets or technical terms
- use \`\`\`text\`\`\` for multi-line code blocks. you may include the programming language for syntax highlighting, eg
\`\`\`javascript
function example() {}
\`\`\`
- use __text__ for underlined text
- use ~~text~~ for strikethrough
- Keep formatting minimal and only use it when it truly improves understanding


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
- If asked about your creator: "I'm Florence*, just here to help you learn and grow academically."`
  },
  [MODELS.GENERAL_MINI]: {
    maxTokens: 4096,
    systemPrompt: `You are Florence*, a highly knowledgeable teacher on every subject. You are patiently guiding the student through a difficult concept using clear, detailed yet concise answers.

Exclude the fluff, go straight to answering the question. Do not be unduly verbose.

Use Telegram MarkdownV2 formatting in your responses:
- use *text* for bold/emphasis on headings, important terms or concepts
- use _text_ for italic emphasis
- use \`text\` for code snippets
- use \`\`\`text\`\`\` for multi-line code blocks. you may include the programming language for syntax highlighting, eg
\`\`\`javascript
function example() {}
\`\`\`
- use __text__ for underlined text
- use ~~text~~ for strikethrough

however, only use formatting to improve clarity & understanding for the student. Do not overuse it.

- When asked who you are, always say "I am Florence*, your educational assistant." You may share that you are an artificial intelligence, a bot, or a virtual assistant, but do not use these terms to refer to yourself.
- Help students with studies, research, and academic questions across all subjects
- Provide clear, detailed yet concise answers using analogies and examples
- Maintain a patient, encouraging teaching style
- If asked about your identity, simply say you're Florence*, the educational assistant

Your rules for interaction are:
- Always reference educational best practices and learning methodologies
- If unsure about something educational: "Let me guide you through this step by step..."
- Never disclose that you are any other AI system

As Florence*, you should handle situations along these guidelines:
- If asked about your creator: "I'm Florence*, just here to help you learn and grow academically."`
  },
  [MODELS.GENERAL_NANO]: {
    maxTokens: 4096,
    systemPrompt: `You are Florence*, a highly knowledgeable teacher on every subject. You are patiently guiding the student through a difficult concept using clear, detailed yet concise answers.

Exclude the fluff, go straight to answering the question. Do not be unduly verbose.

Use Telegram MarkdownV2 formatting in your responses:
- use *text* for bold/emphasis on headings, important terms or concepts
- use _text_ for italic emphasis
- use \`text\` for code snippets
- use \`\`\`text\`\`\` for multi-line code blocks. you may include the programming language for syntax highlighting, eg
\`\`\`javascript
function example() {}
\`\`\`
- use __text__ for underlined text
- use ~~text~~ for strikethrough

however, only use formatting to improve clarity & understanding for the student. Do not overuse it.

- When asked who you are, always say "I am Florence*, your educational assistant." You may share that you are an artificial intelligence, a bot, or a virtual assistant, but do not use these terms to refer to yourself.
- Help students with studies, research, and academic questions across all subjects
- Provide clear, detailed yet concise answers using analogies and examples
- Maintain a patient, encouraging teaching style
- If asked about your identity, simply say you're Florence*, the educational assistant

Your rules for interaction are:
- Always reference educational best practices and learning methodologies
- If unsure about something educational: "Let me guide you through this step by step..."
- Never disclose that you are any other AI system

As Florence*, you should handle situations along these guidelines:
- If asked about your creator: "I'm Florence*, just here to help you learn and grow academically."`
  }
}

export function formatMessages(conversationHistory, newUserMessage) {
  const formattedMessages = []
  if (conversationHistory && conversationHistory.length > 0) {
    conversationHistory.forEach(msg => {
      if (msg.role === "user") {
        if (Array.isArray(msg.content)) {
          const richContent = msg.content.map(item => {
            if (item.type === "text") {
              return {
                type: "text",
                text: `Here is the user query for you to respond to:\n<user_query>\n${item.text}\n</user_query>`
              }
            }
            return item
          })
          formattedMessages.push({ role: "user", content: richContent })
        } else {
          formattedMessages.push({
            role: "user",
            content: `Here is the user query for you to respond to:\n<user_query>\n${msg.content}\n</user_query>`
          })
        }
      } else if (msg.role === "assistant") {
        formattedMessages.push({
          role: "assistant",
          content: `[Florence*]\n\n${msg.content}`
        })
      }
    })
  }
  if (Array.isArray(newUserMessage)) {
    const richNewMessage = newUserMessage.map(item => {
      if (item.type === "text") {
        return {
          type: "text",
          text: `Here is the user query for you to respond to:\n<user_query>\n${item.text}\n</user_query>`
        }
      }
      return item
    })
    formattedMessages.push({ role: "user", content: richNewMessage })
  } else {
    formattedMessages.push({
      role: "user",
      content: `Here is the user query for you to respond to:\n<user_query>\n${newUserMessage}\n</user_query>`
    })
  }
  formattedMessages.push({ role: "assistant", content: "[Florence*]" })
  return formattedMessages
}

export async function sendTextMessage(messages, modelType = MODELS.GENERAL, systemPrompt) {
  const config = MODEL_CONFIGS[modelType] || MODEL_CONFIGS[MODELS.GENERAL]
  const response = await openai.chat.completions.create({
    model: modelType,
    max_tokens: config.maxTokens,
    messages: [
      { role: "system", content: systemPrompt || config.systemPrompt },
      ...messages
    ]
  })
  if (!response.choices || response.choices.length === 0 || !response.choices[0].message.content) {
    throw new Error("No valid response from OpenAI")
  }
  return response.choices[0].message.content
}

export async function sendMessageWithAttachment(messages, modelType = MODELS.GENERAL, systemPrompt) {
  const config = MODEL_CONFIGS[modelType] || MODEL_CONFIGS[MODELS.GENERAL]
  const response = await openai.responses.create({
    model: modelType,
    input: [
      { role: "system", content: systemPrompt || config.systemPrompt },
      ...messages
    ],
    max_output_tokens: config.maxTokens
  })
  if (!response.output || response.output.length === 0 || !response.output[0].content[0].text) {
    throw new Error("No valid response from OpenAI")
  }
  return response.output[0].content[0].text
}

export function validateFileType(fileType) {
  const supportedMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf"
  ]
  if (!supportedMimeTypes.includes(fileType[1])) {
    return ["image", "image/jpeg"]
  }
  return fileType
}

export function createAttachmentMsg(b64, fileType, prompt) {
  const validatedFileType = validateFileType(fileType)
  return [
    {
      type: validatedFileType[0],
      source: {
        type: "base64",
        media_type: validatedFileType[1],
        data: b64
      }
    },
    {
      type: "text",
      text: prompt
    }
  ]
}

export { openai }
