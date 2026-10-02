import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/*
 * Trace ids (design §12): taken from an incoming W3C `traceparent`, otherwise created here. Every log line
 * of a request carries it, and so does every problem response, so a user-visible error can be found in the
 * logs. From M3 it is copied into the outbox headers and travels on to Kafka and the consumers.
 */

// version-traceid-parentid-flags. Version ff and all-zero ids are invalid (W3C Trace Context §3.2).
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_PARENT_ID = '0'.repeat(16);

/** The trace id of a valid `traceparent` header, or undefined. */
export function parseTraceparent(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (match === null) return undefined;
  const [, version, traceId, parentId] = match;
  if (version === 'ff' || traceId === ZERO_TRACE_ID || parentId === ZERO_PARENT_ID) return undefined;
  return traceId;
}

const traceIds = new WeakMap<IncomingMessage, string>();

/**
 * The request's trace id, fixed on first use. Keyed by the raw request because Fastify's child-logger
 * factory, which binds it to every log line, runs before the Fastify request object exists.
 */
export function traceIdOf(raw: IncomingMessage): string {
  let traceId = traceIds.get(raw);
  if (traceId === undefined) {
    traceId = parseTraceparent(raw.headers.traceparent) ?? randomBytes(16).toString('hex');
    traceIds.set(raw, traceId);
  }
  return traceId;
}
