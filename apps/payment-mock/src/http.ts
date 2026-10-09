import type { PspErrorBody, PspErrorCode } from '@flashdrop/contracts';
import { isTransientDbError } from '@flashdrop/db';
import type {
  FastifyReply,
  FastifyRequest,
  FastifySchemaCompiler,
  FastifySerializerCompiler,
  FastifyTypeProvider,
} from 'fastify';
import type { z } from 'zod';

/*
 * Zod as Fastify's schema language (the api's approach, apps/api/src/http/zod.ts) and the PSP's error
 * answers. The PSP plays a third party, so its errors use its own small shape (`PspErrorBody`), not
 * FlashDrop's problem details.
 */

export interface ZodTypeProvider extends FastifyTypeProvider {
  readonly validator: this['schema'] extends z.ZodType ? z.output<this['schema']> : unknown;
  readonly serializer: this['schema'] extends z.ZodType ? z.input<this['schema']> : unknown;
}

type Issue = NonNullable<PspErrorBody['error']['issues']>[number];

export class PspError extends Error {
  override name = 'PspError';
  readonly status: number;
  readonly code: PspErrorCode;
  readonly issues: readonly Issue[] | undefined;

  constructor(status: number, code: PspErrorCode, message: string, issues?: readonly Issue[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

export const validatorCompiler: FastifySchemaCompiler<z.ZodType> =
  ({ schema, httpPart }) =>
  (data) => {
    const result = schema.safeParse(data);
    if (result.success) return { value: result.data };
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return { error: new PspError(400, 'validation_failed', `Invalid ${httpPart ?? 'request'}`, issues) };
  };

/** Parsing, not just stringifying: a response that breaks the contract fails here as a 500, not in a client. */
export const serializerCompiler: FastifySerializerCompiler<z.ZodType> =
  ({ schema }) =>
  (data) =>
    JSON.stringify(schema.parse(data));

const RETRY_AFTER_SECONDS = '1';

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599 ? statusCode : undefined;
}

function toPspError(error: unknown): PspError {
  if (error instanceof PspError) return error;
  // The ledger briefly unreachable, or its session killed mid-commit: the outcome may be unknown, so the
  // caller must retry with the same key, which replays whatever was recorded.
  if (isTransientDbError(error)) return new PspError(503, 'unavailable', 'Ledger unavailable, retry');
  const status = statusCodeOf(error);
  // Fastify's own client errors (bad JSON, 413, 415): their messages are written for callers.
  if (status !== undefined && status < 500 && error instanceof Error) {
    return new PspError(status, status === 404 ? 'not_found' : 'validation_failed', error.message);
  }
  return new PspError(500, 'internal', 'Internal error');
}

export function sendError(reply: FastifyReply, error: PspError): FastifyReply {
  if (error.status === 503) reply.header('retry-after', RETRY_AFTER_SECONDS);
  const body: PspErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.issues ? { issues: [...error.issues] } : {}),
    },
  };
  return reply.code(error.status).send(body);
}

export function handleError(error: Error, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const pspError = toPspError(error);
  if (pspError.status === 503) {
    // A PspError 503 (a simulated outage, a failed readiness check) is logged where it is raised.
    if (error !== pspError) request.log.warn({ err: error }, 'ledger unavailable');
  } else if (pspError.status >= 500) {
    request.log.error({ err: error }, 'request failed');
  }
  return sendError(reply, pspError);
}

export function handleNotFound(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendError(reply, new PspError(404, 'not_found', 'No such route'));
}
