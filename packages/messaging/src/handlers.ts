import type { Logger } from '@flashdrop/config';
import { OrderEvent, type OrderEventOf, type OrderEventType } from '@flashdrop/contracts';
import { z } from 'zod';

/*
 * A consumer is a set of typed handlers, one per event type it acts on (design §6.3, §6.5). The runner and
 * `dlq:replay` both dispatch through `dispatchOrderEvent`, so a replayed event takes exactly the path, and the
 * idempotency checks, of its first delivery. Every handler must be idempotent: Kafka delivers at least once,
 * the relay republishes after a crash, and the runner redelivers finished messages after a retry.
 */

export interface HandlerContext {
  /** Carries `consumer`, `eventId`, `eventType`, `orderId` and `traceId`. */
  readonly logger: Logger;
}

export type OrderEventHandler<T extends OrderEventType> = (
  event: OrderEventOf<T>,
  context: HandlerContext,
) => Promise<void>;

export type OrderEventHandlers = { readonly [T in OrderEventType]?: OrderEventHandler<T> };

/** The consumers `dlq:replay` can run, by the name the runner writes into `x-consumer`. */
export type ConsumerRegistry = Readonly<Record<string, OrderEventHandlers>>;

async function call<E>(
  handler: ((event: E, context: HandlerContext) => Promise<void>) | undefined,
  event: E,
  context: HandlerContext,
): Promise<boolean> {
  if (handler === undefined) return false;
  await handler(event, context);
  return true;
}

/**
 * Runs the handler for the event's type. Resolves `false`, having done nothing, for a type this consumer does
 * not act on: such an event is simply done.
 */
export function dispatchOrderEvent(
  handlers: OrderEventHandlers,
  event: OrderEvent,
  context: HandlerContext,
): Promise<boolean> {
  // One case per type keeps each handler's parameter exact; a new event type fails to compile here.
  switch (event.type) {
    case 'order.reserved':
      return call(handlers['order.reserved'], event, context);
    case 'order.placed':
      return call(handlers['order.placed'], event, context);
    case 'order.paid':
      return call(handlers['order.paid'], event, context);
    case 'order.payment_failed':
      return call(handlers['order.payment_failed'], event, context);
    case 'order.expired':
      return call(handlers['order.expired'], event, context);
    case 'order.cancelled':
      return call(handlers['order.cancelled'], event, context);
    case 'order.rejected':
      return call(handlers['order.rejected'], event, context);
  }
}

export type DecodedEvent =
  | { readonly ok: true; readonly event: OrderEvent }
  | { readonly ok: false; readonly error: string };

/** Validates a record's value against the envelope (§6.2: again on consume). */
export function decodeOrderEvent(value: Buffer | null): DecodedEvent {
  if (value === null) return { ok: false, error: 'empty record value' };
  let json: unknown;
  try {
    json = JSON.parse(value.toString('utf8'));
  } catch (error) {
    return {
      ok: false,
      error: `value is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = OrderEvent.safeParse(json);
  if (!parsed.success) return { ok: false, error: `invalid envelope: ${z.prettifyError(parsed.error)}` };
  return { ok: true, event: parsed.data };
}
