import { User } from '../../models/user.js';
import { ensureConnection } from '../../db/connection.js';
import type { ConversationMessage, SavedConversation } from '../types/index.js';

export async function getHistory(userId: string): Promise<ConversationMessage[]> {
    await ensureConnection();
    const user = await User.findOne({ userId }, 'convoHistory').lean();
    return (user?.convoHistory ?? []) as ConversationMessage[];
}

export async function appendMessages(userId: string, messages: ConversationMessage[]): Promise<void> {
    await ensureConnection();
    const user = await User.findOne({ userId }, 'convoHistory');
    if (!user) return;
    const updated = [...(user.convoHistory ?? []), ...messages];
    await User.findOneAndUpdate({ userId }, { $set: { convoHistory: updated } });
}

export async function resetHistory(userId: string, saveAs?: string): Promise<void> {
    await ensureConnection();

    if (saveAs !== undefined) {
        const user = await User.findOne({ userId }, 'convoHistory convos');
        if (user && user.convoHistory && user.convoHistory.length > 0) {
            const saved = user.convos ?? [];
            saved.push({ title: saveAs, messages: [...user.convoHistory] });
            await User.findOneAndUpdate({ userId }, { $set: { convoHistory: [], convos: saved } });
            return;
        }
    }

    await User.findOneAndUpdate({ userId }, { $set: { convoHistory: [] } });
}

export async function getSavedConversations(userId: string): Promise<SavedConversation[]> {
    await ensureConnection();
    const user = await User.findOne({ userId }, 'convos').lean();
    return (user?.convos ?? []) as SavedConversation[];
}
