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
    botWebhookUrl: optionalEnv('BOT_WEBHOOK_URL') ?? requireEnv('WEBHOOK_URL'),
    webhookUrl: requireEnv('WEBHOOK_URL'),
    claudeApiKey: requireEnv('CLAUDE_API_KEY'),
    paystackSecretKey: requireEnv('PAYSTACK_SK_LIVE'),
    adminApiKey: requireEnv('ADMIN_API_KEY'),
    metaPhoneNumberId: optionalEnv('META_PHONE_NUMBER_ID') ?? '',
    metaAccessToken: optionalEnv('META_ACCESS_TOKEN') ?? '',
    metaVerifyToken: optionalEnv('META_VERIFY_TOKEN') ?? '',
    adminTelegramIds: [
        requireEnv('ADMIN_TG_ID'),
        requireEnv('ADMIN_TG_ID_02'),
    ] as const,
    adminWhatsappIds: [
        requireEnv('ADMIN_WA_ID'),
        requireEnv('ADMIN_WA_ID_02'),
        requireEnv('ADMIN_WA_ID_03')
    ] as const,
    nodeEnv: optionalEnv('NODE_ENV') ?? 'development',
} as const;
