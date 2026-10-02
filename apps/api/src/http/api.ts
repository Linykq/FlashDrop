import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionClaims } from '@flashdrop/contracts';
import type { FastifyBaseLogger, FastifyInstance, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from './zod';

/** The Fastify instance every route module registers on: Zod DTOs as schemas (./zod.ts). */
export type Api = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

declare module 'fastify' {
  interface FastifyRequest {
    /** From the incoming `traceparent`, else created here (design §12). Bound to every log line. */
    readonly traceId: string;
    /** The verified `fd_session` claims; null for anonymous callers and invalid or expired tokens. */
    session: SessionClaims | null;
  }
}
