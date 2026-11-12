import { config } from '../config/index.js';

export type LoginProvider = 'telegram' | 'whatsapp';

export type ClaimResult = 'verified' | 'already_used' | 'invalid' | 'unavailable';

const LOGIN_CODE = /^FLO-\d{6}$/;

export function parseLoginCode(text: string): string | null {
    const code = text.trim().toUpperCase();
    return LOGIN_CODE.test(code) ? code : null;
}

export async function claimLoginCode(input: {
    provider: LoginProvider;
    code: string;
    providerUserId: string;
    displayName?: string;
    username?: string;
}): Promise<ClaimResult> {
    if (!config.florenceApiUrl || !config.florenceApiSecret) return 'unavailable';
    try {
        const res = await fetch(`${config.florenceApiUrl}/internal/v1/auth/challenges/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': config.florenceApiSecret },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return 'verified';
        if (res.status === 409) return 'already_used';
        if (res.status === 404 || res.status === 400) return 'invalid';
        return 'unavailable';
    } catch (error) {
        console.error('Florence API claim failed:', error);
        return 'unavailable';
    }
}

export function claimReply(result: ClaimResult): string {
    switch (result) {
        case 'verified':
            return 'Done. Go back to the Florence app to finish signing in.';
        case 'already_used':
            return 'That code was already used. Start again in the Florence app to get a new one.';
        case 'invalid':
            return 'That code is wrong or has expired. Start again in the Florence app to get a new one.';
        default:
            return 'Sign-in is not available right now. Please try again in a few minutes.';
    }
}
