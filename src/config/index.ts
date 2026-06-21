function requireEnv(key: string): string {
    const value = process.env[key];
    if (!value) throw new Error(`Missing required environment variable: ${key}`);
    return value;
}

function optionalEnv(key: string): string | undefined {
    return process.env[key];
}

export const config = {
    port: optionalEnv('PORT') ?? '3000',
    mongoUri: requireEnv('MONGODB_URI'),
    botToken: requireEnv('BOT_TOKEN'),
    botWebhookUrl: requireEnv('BOT_WEBHOOK_URL'),
    webhookUrl: requireEnv('WEBHOOK_URL'),
    claudeApiKey: requireEnv('CLAUDE_API_KEY'),
    paystackSecretKey: requireEnv('PAYSTACK_SK_LIVE'),
    adminApiKey: requireEnv('ADMIN_API_KEY'),
    metaPhoneNumberId: requireEnv('META_PHONE_NUMBER_ID'),
    metaAccessToken: requireEnv('META_ACCESS_TOKEN'),
    metaVerifyToken: requireEnv('META_VERIFY_TOKEN'),
    adminTelegramIds: ['7258562406', '489613046'] as const,
    nodeEnv: optionalEnv('NODE_ENV') ?? 'development',
} as const;
