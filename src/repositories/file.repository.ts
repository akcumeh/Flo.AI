// Tracks Anthropic file ids per user so they can be released on conversation
// reset. In-memory only: survives a single serverless invocation, which is
// correct for dev; durable persistence lands with Phase 4's stored_files table.
const fileMap = new Map<string, string[]>();

export function trackFile(userId: string, anthropicFileId: string): void {
    const existing = fileMap.get(userId) ?? [];
    fileMap.set(userId, [...existing, anthropicFileId]);
}

export function getTrackedFiles(userId: string): string[] {
    return fileMap.get(userId) ?? [];
}

export function clearTrackedFiles(userId: string): string[] {
    const files = fileMap.get(userId) ?? [];
    fileMap.delete(userId);
    return files;
}
