export class AppError extends Error {
    constructor(
        public override message: string,
        public statusCode: number = 500
    ) {
        super(message);
        this.name = this.constructor.name;
    }
}

export class InsufficientTokensError extends AppError {
    constructor() {
        super('Insufficient tokens', 402);
    }
}

export class UserNotFoundError extends AppError {
    constructor(userId: string) {
        super(`User not found: ${userId}`, 404);
    }
}

export class PaymentVerificationError extends AppError {
    constructor(message: string) {
        super(message, 400);
    }
}

export class UnauthorizedError extends AppError {
    constructor() {
        super('Unauthorized', 401);
    }
}
