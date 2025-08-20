import assert from 'assert'
import { formatMessages, validateFileType, createAttachmentMsg, openai } from './utils/openaiAPI.js'
import { askGpt, askGptWithAtt } from './utils/utils.js'

async function run() {
  const conversation = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello' }
  ]
  const formatted = formatMessages(conversation, 'How are you?')
  assert.strictEqual(formatted.length, 4)
  assert.deepStrictEqual(formatted[0], { role: 'user', content: 'Here is the user query for you to respond to:\n<user_query>\nHi\n</user_query>' })
  assert.deepStrictEqual(formatted[1], { role: 'assistant', content: '[Florence*]\n\nHello' })
  assert.strictEqual(formatted[2].role, 'user')
  assert.strictEqual(formatted[3].content, '[Florence*]')

  assert.deepStrictEqual(validateFileType(['image', 'image/tiff']), ['image', 'image/jpeg'])
  assert.deepStrictEqual(validateFileType(['image', 'image/png']), ['image', 'image/png'])

  const attachment = createAttachmentMsg('abc', ['image', 'image/png'], 'test')
  assert.deepStrictEqual(attachment, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    { type: 'text', text: 'test' }
  ])

  openai.chat = { completions: { create: async () => ({ choices: [{ message: { content: '[Florence*] hi' } }] }) } }
  const text = await askGpt({ convoHistory: [] }, 'hello')
  assert.strictEqual(text, 'hi')

  openai.responses = { create: async () => ({ output: [{ content: [{ text: '[Florence*] img' }] }] }) }
  const att = await askGptWithAtt({ convoHistory: [] }, 'base64data', ['image', 'image/png'], 'prompt')
  assert.strictEqual(att, 'img')

  console.log('All tests passed')
}

run()

