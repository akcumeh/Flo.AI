import { MediaGroup } from '../../models/mediaGroup.js';
import { ensureConnection } from '../../db/connection.js';
import { plainOrNull } from './mongo.util.js';
import type { IMediaGroup, MediaGroupItem } from '../types/index.js';

export async function getCollectingGroup(userId: string, mediaGroupId: string): Promise<IMediaGroup | null> {
    await ensureConnection();
    return plainOrNull<IMediaGroup>(await MediaGroup.findOne({ userId, mediaGroupId, status: 'collecting' }).lean());
}

export async function addMediaItem(
    userId: string,
    mediaGroupId: string,
    caption: string,
    item: MediaGroupItem
): Promise<number> {
    await ensureConnection();
    const doc = await MediaGroup.findOne({ userId, mediaGroupId, status: 'collecting' });

    if (!doc) {
        const created = await MediaGroup.create({
            userId,
            mediaGroupId,
            status: 'collecting',
            caption,
            mediaItems: [item],
            tokenCost: 2,
            expiresAt: new Date(Date.now() + 60000),
            lastActivity: new Date(),
        });
        return created.mediaItems.length;
    }

    doc.lastActivity = new Date();
    if (caption && !doc.caption) doc.caption = caption;
    if (!doc.mediaItems.some((existing) => existing.fileId === item.fileId)) {
        doc.mediaItems.push(item);
    }
    await doc.save();
    return doc.mediaItems.length;
}

export interface MediaGroupPatch {
    status?: IMediaGroup['status'];
    error?: string;
    result?: string;
}

export async function updateMediaGroup(id: string, patch: MediaGroupPatch): Promise<void> {
    await ensureConnection();
    await MediaGroup.updateOne({ _id: id }, { $set: patch });
}
