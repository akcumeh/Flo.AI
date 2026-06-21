import type { Document } from 'mongoose';

export type Platform = 'telegram' | 'whatsapp';

export interface PlatformUser {
    platformId: string;
    platform: Platform;
    name: string;
}

export interface MessageContent {
    type: 'text' | 'photo' | 'document';
    text?: string;
    fileId?: string;
    mimeType?: string;
    caption?: string;
}

export interface ConversationMessage {
    role: 'user' | 'assistant';
    content: string | MessageContent[];
}

export interface SavedConversation {
    title: string;
    messages: ConversationMessage[];
}

export interface TokenBundle {
    amount: number;
    tokens: number;
}

export interface PaymentResult {
    success: boolean;
    authorizationUrl?: string;
    reference?: string;
    message: string;
}

export interface VerificationResult {
    success: boolean;
    tokens?: number;
    amount?: number;
    userId?: string;
    isPending?: boolean;
    message: string;
}

export interface AnalyticsData {
    totalUsers: number;
    newUsers: number;
    totalRevenue: number;
    uniqueCustomers: number;
}

export interface StreakResult {
    user: IUser;
    streakIncreased: boolean;
    isNewStreak: boolean;
}

export interface StreakInfo {
    streak: number;
    lastActive: Date | null;
    name: string;
}

// Mongoose document interfaces

export interface IUser extends Document {
    userId: string;
    name: string;
    email?: string;
    tokens: number;
    streak: number;
    convoHistory: ConversationMessage[];
    convos: SavedConversation[];
    lastTokenReward: Date;
    lastActiveDate: Date | null;
    lastStreakUpdate: Date | null;
    lastStreakReminder: Date | null;
    lastStreakReward: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface ITransaction extends Document {
    userId: string;
    reference: string;
    amount: number;
    tokens: number;
    email?: string;
    status: 'pending' | 'success' | 'failed';
    completedAt?: Date;
    gatewayResponse?: object;
    metadata?: object;
    createdAt: Date;
    hasExpired(): boolean;
}

export interface IRequestState extends Document {
    userId: string;
    messageId: string | number;
    status: 'processing' | 'completed' | 'cancelled' | 'failed';
    tokenCost: number;
    prompt?: string;
    isMedia: boolean;
    mediaType: 'photo' | 'document' | null;
    mediaFileId?: string;
    mediaMimeType?: string;
    mediaFileName?: string;
    error?: string;
    createdAt: Date;
}

export interface IPaymentState extends Document {
    userId: string;
    step: 'init' | 'bundle_select' | 'email' | 'save_card' | 'processing' | 'completed' | 'cancelled';
    method: 'card' | 'bank' | null;
    amount: number;
    tokens: number;
    email?: string;
    saveCard: boolean;
    reference?: string;
    paystackReference?: string;
    createdAt: Date;
}

export interface IMediaGroup extends Document {
    userId: string;
    status: 'collecting' | 'processing' | 'completed' | 'cancelled' | 'failed';
    caption: string;
    mediaItems: Array<{ fileId: string; type: 'photo' | 'document' }>;
    tokenCost: number;
    result?: string;
    error?: string;
    expiresAt?: Date;
    lastActivity: Date;
    createdAt: Date;
}

export interface IVerificationState extends Document {
    userId: string;
    reference: string;
    status: 'verified' | 'failed';
    tokens: number;
    verifiedAt: Date;
}

// DTOs

export interface CreateUserDto {
    id: string;
    name: string;
    tokens?: number;
    email?: string;
}
