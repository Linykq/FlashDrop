import { ERROR_CODES } from '@flashdrop/domain';
import { z } from 'zod';

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * Every error response of `api`: RFC 9457 problem details plus FlashDrop's stable `code`, which clients
 * branch on (`SOLD_OUT`, `RETRY`, ...). `title` and `detail` are for people and may change.
 */
export const ProblemDetails = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.int().min(400).max(599),
  code: ErrorCode,
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** The request's trace id (§12), so a user-visible error can be found in the logs. */
  traceId: z.string().optional(),
  /** Field-level problems of a `VALIDATION_FAILED`. */
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.output<typeof ProblemDetails>;
