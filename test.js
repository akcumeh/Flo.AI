import Anthropic from '@anthropic-ai/sdk';
import dotenv, { configDotenv } from 'dotenv';

dotenv.config();

const anthropic = new Anthropic({
    apiKey: process.env.CLAUDE_API_KEY
});

let claude = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [
        { "role": "user", "content": "Hello, Claude" },
        { "role": "assistant", "content": "Hello!" },
        { "role": "user", "content": "Can you describe LLMs to me?" },
        { "role": "assistant", "content": "Large Language Models (LLMs) like myself are AI systems trained on vast amounts of text data to understand and generate human-like text. Here are the key points about LLMs:  1. Training: - Trained on massive datasets of text from the internet, books, and other sources - Learn patterns in language through machine learning techniques - Use transformer architecture, which helps process and understand context in text  2. Capabilities: - Can understand and generate human language - Answer questions and engage in conversations - Assist with writing and editing - Summarize text - Translate languages - Code completion and explanation - Analysis and reasoning tasks  3. Limitations: - Can make mistakes or provide inaccurate information - May generate plausible-sounding but incorrect responses - Don't have true understanding or consciousness - Can be biased based on training data - Can't access real-time information - Don't have direct experience of the physical world  4. Main Uses: - Customer service - Content creation - Research assistance - Education - Programming help - Data analysis - Language translation  LLMs represent a significant advance in AI technology but should be used with an understanding of both their capabilities and limitations." },
        { "role": "user", "content": "How do LLMs generate text?" }
    ]
});

console.log(claude.content[0].text);