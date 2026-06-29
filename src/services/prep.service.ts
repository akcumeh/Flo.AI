import { Session } from '../../models/session.js';
import { QuizResult } from '../../models/quizResult.js';
import { ensureConnection } from '../../db/connection.js';
import * as userRepo from '../repositories/user.repository.js';
import * as assistantService from './assistant.service.js';
import type { ISession, ExamQuestion } from '../types/index.js';

export const MAX_FILES = 5;
export const MAX_QUESTIONS = 10;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2h inactivity janitor

type Platform = 'tg' | 'wa';

function newExpiry(): Date {
    return new Date(Date.now() + SESSION_TTL_MS);
}

/** The user's current open session (any non-completed-and-closed state), or null. */
export async function getActiveSession(userId: string): Promise<ISession | null> {
    await ensureConnection();
    return Session.findOne({ userId }) as unknown as Promise<ISession | null>;
}

/** Open a fresh prep session. Caller guarantees no active session exists. */
export async function start(userId: string, platform: Platform): Promise<ISession> {
    await ensureConnection();
    // Defensive: clear any stale session for this user before opening a new one.
    const existing = await getActiveSession(userId);
    if (existing) await releaseFiles(existing);
    await Session.deleteMany({ userId });

    return Session.create({
        userId,
        platform,
        mode: 'prep',
        status: 'collecting',
        expiresAt: newExpiry(),
    }) as unknown as Promise<ISession>;
}

/** Upload a file to Anthropic and attach it to the session (capped at MAX_FILES). */
export async function addFile(
    session: ISession,
    buffer: Buffer,
    fileName: string,
    mimeType: string
): Promise<{ added: boolean; count: number }> {
    if (session.fileIds.length >= MAX_FILES) {
        return { added: false, count: session.fileIds.length };
    }
    const kind: 'image' | 'document' = mimeType.startsWith('image/') ? 'image' : 'document';
    const anthropicFileId = await assistantService.uploadPrepFile(buffer, fileName, mimeType);
    session.fileIds.push({ anthropicFileId, fileName: kind === 'image' ? null : fileName, kind });
    session.expiresAt = newExpiry();
    await session.save();
    return { added: true, count: session.fileIds.length };
}

/**
 * Record the requested question count, gated against the user's balance (each
 * generated question costs 1 token). Returns the effective count to generate.
 */
export async function setCount(session: ISession, requested: number): Promise<number> {
    const user = await userRepo.findUser(session.userId);
    const balance = user?.tokens ?? 0;
    // Cap to balance and to MAX_QUESTIONS; never below 1.
    const effective = Math.max(1, Math.min(requested, MAX_QUESTIONS, balance > 0 ? balance : 1));
    session.requestedCount = effective;
    session.status = 'choosing';
    session.expiresAt = newExpiry();
    await session.save();
    return effective;
}

/** Generate the questions and move the session into the quizzing state. */
export async function generate(session: ISession): Promise<ExamQuestion[]> {
    const count = session.requestedCount > 0 ? session.requestedCount : 1;
    const questions = await assistantService.generateQuestions(session.fileIds, count);

    session.questions = questions;
    session.generatedCount = questions.length;
    session.currentIndex = 0;
    session.status = 'quizzing';
    session.expiresAt = newExpiry();
    await session.save();
    return questions;
}

export function currentQuestion(session: ISession): ExamQuestion | null {
    return session.questions[session.currentIndex] ?? null;
}

function normalize(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Local MCQ grading: accept a match on the full option text, or on an option
// letter (A/B/C/D) mapped to the correct option.
function gradeMcqLocally(question: ExamQuestion, userAnswer: string): boolean {
    const ans = normalize(question.answer);
    const chosen = normalize(userAnswer);
    if (chosen === ans) return true;

    const options = question.options ?? [];
    const correctIdx = options.findIndex((o) => normalize(o) === ans);
    if (correctIdx === -1) return false;

    // Letter form, e.g. "a" or "a)" or "a."
    const letter = chosen.replace(/[).\s]/g, '');
    if (letter.length === 1) {
        const idx = letter.charCodeAt(0) - 'a'.charCodeAt(0);
        if (idx === correctIdx) return true;
    }
    // Chosen text matches the correct option text.
    return normalize(options[correctIdx] ?? '') === chosen;
}

export interface AnswerOutcome {
    correct: boolean;
    explanation: string;
    sourceLabel: string;
    done: boolean;
    nextQuestion: ExamQuestion | null;
    questionNumber: number; // 1-based number of the question just answered
    total: number;
}

/** Grade + explain the current question, advance, and report what comes next. */
export async function submitAnswer(session: ISession, userAnswer: string): Promise<AnswerOutcome> {
    const q = currentQuestion(session);
    if (!q) throw new Error('No active question');

    const answeredNumber = session.currentIndex + 1;
    let correct: boolean;
    let awardedMarks: number;
    let explanation: string;

    if (q.type === 'mcq') {
        correct = gradeMcqLocally(q, userAnswer);
        awardedMarks = correct ? q.marks : 0;
        explanation = await assistantService.explainMcq(session.fileIds, q, userAnswer, correct);
    } else {
        const result = await assistantService.gradeAndExplain(session.fileIds, q, userAnswer);
        correct = result.correct;
        awardedMarks = result.awardedMarks;
        explanation = result.explanation;
    }

    session.answers.push({ index: session.currentIndex, userAnswer, correct, awardedMarks });
    session.score += awardedMarks;
    session.currentIndex += 1;
    session.expiresAt = newExpiry();
    await session.save();

    const done = session.currentIndex >= session.questions.length;
    return {
        correct,
        explanation,
        sourceLabel: q.sourceLabel,
        done,
        nextQuestion: done ? null : currentQuestion(session),
        questionNumber: answeredNumber,
        total: session.questions.length,
    };
}

export interface CompletionResult {
    correctCount: number;
    total: number;
    failedTopics: string[];
    failedSources: string[];
    cost: number;
    balanceAfter: number;
}

// Release Anthropic-stored files exactly once.
async function releaseFiles(session: ISession): Promise<void> {
    if (session.filesReleased) return;
    await Promise.all(session.fileIds.map((f) => assistantService.deletePrepFile(f.anthropicFileId)));
    session.filesReleased = true;
}

// Compute and apply the deferred token charge exactly once.
// No file uploaded means no API call was ever made, so there is nothing to charge.
// Otherwise: cost = (g === 1 && answered >= 1) ? 1 : max(g, 2).
async function finalizeCharge(session: ISession): Promise<{ cost: number; balanceAfter: number }> {
    const user = await userRepo.findUser(session.userId);
    const balance = user?.tokens ?? 0;
    if (session.charged) return { cost: 0, balanceAfter: balance };

    const g = session.generatedCount;
    const answered = session.answers.length;
    const cost =
        session.fileIds.length === 0 ? 0 : g === 1 && answered >= 1 ? 1 : Math.max(g, 2);

    const newBalance = Math.max(0, balance - cost);
    await userRepo.updateUser(session.userId, { tokens: newBalance });
    session.charged = true;
    return { cost, balanceAfter: newBalance };
}

/** Quiz finished: score it, persist a quizResult, charge, release files. */
export async function complete(session: ISession): Promise<CompletionResult> {
    const correctCount = session.answers.filter((a) => a.correct).length;
    const total = session.generatedCount;

    const failedTopics = [
        ...new Set(
            session.answers
                .filter((a) => !a.correct)
                .map((a) => session.questions[a.index]?.topic)
                .filter((t): t is string => Boolean(t))
        ),
    ];
    const failedSources = [
        ...new Set(
            session.answers
                .filter((a) => !a.correct)
                .map((a) => session.questions[a.index]?.sourceLabel)
                .filter((s): s is string => Boolean(s))
        ),
    ];

    session.status = 'completed';
    const { cost, balanceAfter } = await finalizeCharge(session);
    await releaseFiles(session);
    await session.save();

    await QuizResult.create({
        userId: session.userId,
        mode: session.mode,
        score: correctCount,
        total,
        failedTopics,
        sourceDocs: failedSources,
    });

    // Auto-close on completion: charge and files are settled, so there is no
    // dangling session to /exit. Early bail-out still goes through exit().
    await Session.deleteOne({ _id: session._id });

    return { correctCount, total, failedTopics, failedSources, cost, balanceAfter };
}

export interface ExitResult {
    cost: number;
    balanceAfter: number;
    wasCompleted: boolean;
}

/** Explicit close (/exit). Charges if not already charged, releases files, removes the session. */
export async function exit(session: ISession): Promise<ExitResult> {
    const wasCompleted = session.status === 'completed';
    const { cost, balanceAfter } = await finalizeCharge(session);
    await releaseFiles(session);
    await session.save();
    await Session.deleteOne({ _id: session._id });
    return { cost, balanceAfter, wasCompleted };
}
