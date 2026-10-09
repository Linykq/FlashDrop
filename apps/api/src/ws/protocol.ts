import { ClientMessage } from '@flashdrop/contracts';
import type { RawData } from 'ws';
import type { z } from 'zod';

/*
 * Parsing at the gateway's two boundaries (design §7): client frames and Redis channel payloads. Both are
 * JSON validated with the contracts' Zod schemas; anything else is null, and the caller decides what that
 * costs (a client is closed with 1008, a bad publish is logged and dropped).
 */

/** The text of a frame; `ws` hands over a Buffer, a fragmented message's Buffers, or an ArrayBuffer. */
export function textOf(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** `JSON.parse` plus `schema`; null for invalid JSON or a value the schema refuses. */
export function parseJson<T>(schema: z.ZodType<T>, text: string): T | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseClientMessage(text: string): ClientMessage | null {
  return parseJson(ClientMessage, text);
}
