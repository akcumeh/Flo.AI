import Anthropic from '@anthropic-ai/sdk';
import dotenv, { configDotenv } from 'dotenv';
import {
    askClaude,
    askClaudeWithAtt
} from './utils/utils.js';

dotenv.config();


askClaude()

console.log(claude.content[0].text);