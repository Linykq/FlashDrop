import { STATUS_CODES } from 'node:http';
import { type ErrorCode, PROBLEM_CONTENT_TYPE, type ProblemDetails } from '@flashdrop/contracts';
import { isTransientDbError } from '@flashdrop/db';
import { BugError, DomainError, RetryError, ValidationError } from '@flashdrop/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';

/*
 * Every error leaves the api as RFC 9457 problem details with a stable `code` (design §5.1). The mapping
 * from code to status lives once, in `ERROR_STATUS` (packages/domain); this module only decides which code
 * an error carries and how much of it is safe to show.
 */

export interface Problem {
  readonly body: ProblemDetails;
  /** Extra response headers, e.g. `Retry-After` on a 503. */
  readonly headers: Readonly<Record<string, string>>;
}

/** Codes for Fastify's own 4xx errors (bad JSON, 413, 415, and from M2 the rate limiter's 429). */
const CLIENT_ERROR_CODES: Readonly<Partial<Record<number, ErrorCode>>> = {
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
};

const RETRY_AFTER_SECONDS = 1;

function details(
  status: number,
  code: ErrorCode,
  detail: string | undefined,
  traceId: string,
): ProblemDetails {
  return {
    type: 'about:blank',
    // With type about:blank, RFC 9457 §4.2.1 makes the title the status phrase.
    title: STATUS_CODES[status] ?? 'Error',
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
    traceId,
  };
}

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599 ? statusCode : undefined;
}

function detailOf(error: DomainError): string | undefined {
  // A BugError's message describes our internals; it is for the logs only.
  if (error instanceof BugError) return undefined;
  // Fastify tags request-validation failures with the part that failed: body, querystring, params.
  if ('validationContext' in error && typeof error.validationContext === 'string') {
    return `Invalid ${error.validationContext}`;
  }
  return error.message;
}

/** The problem response for `error`. Anything unrecognised is a 500 that reveals nothing. */
export function toProblem(error: unknown, traceId: string): Problem {
  if (error instanceof DomainError) {
    const body = details(error.status, error.code, detailOf(error), traceId);
    if (error instanceof ValidationError) body.errors = [...error.issues];
    const headers: Record<string, string> =
      error instanceof RetryError ? { 'retry-after': String(error.retryAfterSeconds) } : {};
    return { body, headers };
  }
  const status = statusCodeOf(error);
  // Postgres briefly unreachable or the session killed (design delta 7), or a plugin's own 503.
  if (isTransientDbError(error) || status === 503) {
    return {
      body: details(503, 'RETRY', 'Temporarily unavailable, retry', traceId),
      headers: { 'retry-after': String(RETRY_AFTER_SECONDS) },
    };
  }
  if (status !== undefined && status < 500 && error instanceof Error) {
    // Fastify's own client errors (body parsing, content type, size): their messages are written for callers.
    const code = CLIENT_ERROR_CODES[status] ?? 'VALIDATION_FAILED';
    return { body: details(status, code, error.message, traceId), headers: {} };
  }
  return { body: details(500, 'INTERNAL', undefined, traceId), headers: {} };
}

export function sendProblem(reply: FastifyReply, { body, headers }: Problem): FastifyReply {
  return reply.code(body.status).headers(headers).type(PROBLEM_CONTENT_TYPE).send(body);
}

/** Fastify error handler: logs what needs attention, then answers with problem details. */
export function handleError(error: Error, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const problem = toProblem(error, request.traceId);
  const { status } = problem.body;
  if (status === 503) request.log.warn({ err: error }, 'dependency unavailable');
  else if (status >= 500) request.log.error({ err: error }, 'request failed');
  return sendProblem(reply, problem);
}

export function handleNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendProblem(reply, toProblem(new DomainError('NOT_FOUND', 'No such route'), request.traceId));
}
