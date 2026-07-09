import mongoose from 'mongoose';
import type { ISession } from '../src/types/index.js';

// Generalized session framework. `mode` is extensible (prep now; grader,
// research later). `/exit` is the primary close; the TTL index on `expiresAt`
// is only an abandoned-session janitor (it also frees Anthropic-stored files).
const questionSchema = new mongoose.Schema(
    {
        type: { type: String, enum: ['mcq', 'theory', 'short'], required: true },
        question: { type: String, required: true },
        options: { type: [String], default: undefined },
        answer: { type: String, required: true },
        marks: { type: Number, default: 1 },
        difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
        topic: { type: String, default: '' },
        sourceLabel: { type: String, default: '' },
    },
    { _id: false }
);

const answerSchema = new mongoose.Schema(
    {
        index: { type: Number, required: true },
        userAnswer: { type: String, default: '' },
        correct: { type: Boolean, default: false },
        awardedMarks: { type: Number, default: 0 },
    },
    { _id: false }
);

const fileSchema = new mongoose.Schema(
    {
        anthropicFileId: { type: String, required: true },
        fileName: { type: String, default: null },
        kind: { type: String, enum: ['image', 'document'], default: 'document' },
    },
    { _id: false }
);

const sessionSchema = new mongoose.Schema(
    {
        userId: { type: String, required: true, index: true },
        platform: { type: String, enum: ['tg', 'wa'], required: true },
        mode: { type: String, enum: ['prep', 'create'], default: 'prep' },
        status: {
            type: String,
            enum: ['collecting', 'choosing', 'quizzing', 'completed'],
            default: 'collecting',
        },
        fileIds: { type: [fileSchema], default: [] },
        requestedCount: { type: Number, default: 0 },
        generatedCount: { type: Number, default: 0 },
        questions: { type: [questionSchema], default: [] },
        currentIndex: { type: Number, default: 0 },
        answers: { type: [answerSchema], default: [] },
        score: { type: Number, default: 0 },
        charged: { type: Boolean, default: false },
        filesReleased: { type: Boolean, default: false },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: true }
);

// One active session per user is enforced at the service layer; this index just
// keeps lookups fast.
sessionSchema.index({ userId: 1, status: 1 });
// TTL janitor: documents are removed once `expiresAt` passes.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = (
    mongoose.models['Session'] ?? mongoose.model('Session', sessionSchema)
) as mongoose.Model<ISession>;
