import { TOPICS } from '@flashdrop/config';
import {
  ORDER_EVENT_SCHEMA_VERSION,
  OrderEvent,
  type OrderEventData,
  type OrderEventOf,
  type OrderEventType,
} from '@flashdrop/contracts';
import { BugError } from '@flashdrop/domain';
import { uuidv7 } from '@flashdrop/domain/identity';
import type { Tx } from './client';
import { outbox } from './schema';

/*
 * The transactional outbox (design §5.4): every status change writes its event in the same transaction, so
 * an event exists exactly when the change committed (INV-5). The relay publishes rows to Kafka keyed by
 * `partition_key` = productId (§6.1).
 */

/** The ids of the order an event reports on. */
export interface OrderEventSubject {
  readonly id: string;
  /** `orders.version` after the change. */
  readonly version: number;
  readonly productId: string;
  readonly dropId: string;
  readonly userId: string;
}

export interface OrderEventOptions {
  /** When the change happened, by Postgres time where the statement returns it. */
  readonly occurredAt: Date;
  readonly traceId?: string;
}

/** Builds an envelope with a fresh uuidv7 `eventId`, the consumers' dedupe key. */
export function orderEvent<T extends OrderEventType>(
  type: T,
  order: OrderEventSubject,
  data: OrderEventData<T>,
  options: OrderEventOptions,
): OrderEventOf<T> {
  // The generic `type` cannot narrow the union by itself; the parse in insertOutboxEvents checks the result.
  return {
    eventId: uuidv7(),
    schemaVersion: ORDER_EVENT_SCHEMA_VERSION,
    occurredAt: options.occurredAt.toISOString(),
    orderId: order.id,
    orderVersion: order.version,
    productId: order.productId,
    dropId: order.dropId,
    userId: order.userId,
    ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
    type,
    data,
  } as OrderEventOf<T>;
}

/** Validates an envelope (§6.2: before the outbox insert); an invalid one is a producer bug. */
export function validateOrderEvent(event: OrderEvent): OrderEvent {
  const parsed = OrderEvent.safeParse(event);
  if (!parsed.success) throw new BugError(`invalid ${event.type} event: ${parsed.error.message}`);
  return parsed.data;
}

/** The outbox row of a validated event. The trace id rides along as a header to the Kafka message (§12). */
export function outboxRow(event: OrderEvent): typeof outbox.$inferInsert {
  const valid = validateOrderEvent(event);
  return {
    eventId: valid.eventId,
    topic: TOPICS.orders,
    partitionKey: valid.productId,
    eventType: valid.type,
    payload: valid,
    headers: valid.traceId === undefined ? {} : { 'trace-id': valid.traceId },
  };
}

/**
 * Inserts the events into the outbox inside the caller's transaction, so they commit or roll back with the
 * status change they report. No NOTIFY here: only low-rate paths notify the relay (§5.4).
 */
export async function insertOutboxEvents(tx: Tx, events: readonly OrderEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx.insert(outbox).values(events.map(outboxRow));
}
