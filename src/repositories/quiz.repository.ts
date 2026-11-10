import { QuizResult } from '../../models/quizResult.js';
import { ensureConnection } from '../../db/connection.js';

export interface CreateQuizResultDto {
    userId: string;
    mode: string;
    score: number;
    total: number;
    failedTopics: string[];
    sourceDocs: string[];
}

export async function createQuizResult(data: CreateQuizResultDto): Promise<void> {
    await ensureConnection();
    await QuizResult.create(data);
}
