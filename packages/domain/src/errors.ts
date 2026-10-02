/*
 * Typed errors every layer throws (CLAUDE.md). Each carries a stable machine `code` from the API reference
 * (design §5.1, §5.2); `api` turns them into problem details (`ProblemDetails` in `packages/contracts`) with
 * the status from `ERROR_STATUS`, so the code-to-status mapping exists exactly once.
 */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'SOLD_OUT',
  'LIMIT_REACHED',
  'DROP_NOT_LIVE',
  'ALREADY_SUBMITTED',
  'DROP_ARMED',
  'DROP_BUSY',
  'RESERVATION_EXPIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
  'INTERNAL',
  'RETRY',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  // Also for other users' orders: §11 answers 404, never 403, so ids cannot be probed.
  NOT_FOUND: 404,
  // A compare-and-set that lost, without a more specific reason (extend, cancel).
  CONFLICT: 409,
  SOLD_OUT: 409,
  LIMIT_REACHED: 409,
  DROP_NOT_LIVE: 409,
  ALREADY_SUBMITTED: 409,
  DROP_ARMED: 409,
  DROP_BUSY: 409,
  RESERVATION_EXPIRED: 410,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  // The drop is reconciling or a dependency is briefly unavailable: retry with the same Idempotency-Key.
  RETRY: 503,
};

/** Base class: an expected outcome with a stable code, safe to show to the caller. */
export class DomainError extends Error {
  override name = 'DomainError';
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export class NotFoundError extends DomainError {
  override name = 'NotFoundError';

  constructor(resource: string, options?: ErrorOptions) {
    super('NOT_FOUND', `${resource} not found`, options);
  }
}

export interface ValidationIssue {
  /** Dotted path into the input, e.g. `shipping.postalCode`; empty for the input as a whole. */
  readonly path: string;
  readonly message: string;
}

export class ValidationError extends DomainError {
  override name = 'ValidationError';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[], options?: ErrorOptions) {
    super('VALIDATION_FAILED', 'The request is invalid', options);
    this.issues = issues;
  }
}

/** 503 with `Retry-After`: the caller should retry the same request, with the same Idempotency-Key. */
export class RetryError extends DomainError {
  override name = 'RetryError';
  readonly retryAfterSeconds: number;

  constructor(message = 'Temporarily unavailable, retry', retryAfterSeconds = 1, options?: ErrorOptions) {
    super('RETRY', message, options);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * A broken internal assumption, e.g. an unvalidated `qty` reaching Lua (§5.2). Answered with 500 and an
 * alert; the message is for logs, never for the caller.
 */
export class BugError extends DomainError {
  override name = 'BugError';

  constructor(message: string, options?: ErrorOptions) {
    super('INTERNAL', message, options);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
