import mongoose from 'mongoose';
import type { IQuizResult } from '../src/types/index.js';

// Persisted on quiz completion. Step 2 (analytics) reads this for per-topic weak
// spots and score history.
const quizResultSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    mode: { type: String, default: 'prep' },
    score: { type: Number, required: true },
    total: { type: Number, required: true },
    failedTopics: { type: [String], default: [] },
    sourceDocs: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
});

export const QuizResult = (
    mongoose.models['QuizResult'] ?? mongoose.model('QuizResult', quizResultSchema)
) as mongoose.Model<IQuizResult>;
