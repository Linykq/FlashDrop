import { randomUUID } from 'node:crypto';
import { createLogger, type Logger } from '@flashdrop/config';
import {
  ORDER_EVENT_SCHEMA_VERSION,
  type OrderEventData,
  type OrderEventOf,
  type OrderEventType,
} from '@flashdrop/contracts';

/*
 * Test-only helpers: valid order events with fresh ids, and a logger whose lines a test can inspect (alerts
 * are log lines, §12).
 */

const SAMPLE_DATA: { readonly [T in OrderEventType]: OrderEventData<T> } = {
  'order.reserved': { qty: 1, unitPriceCents: 1_999, expiresAt: '2026-10-02T12:02:00.000Z' },
  'order.placed': {
    qty: 1,
    totalCents: 1_999,
    currency: 'USD',
    paymentMethod: 'pm_ok',
    expiresAt: '2026-10-02T12:07:00.000Z',
  },
  'order.paid': { qty: 1, totalCents: 1_999, pspChargeId: 'ch_test' },
  'order.payment_failed': { qty: 1, declineCode: 'card_declined' },
  'order.expired': { qty: 1, fromStatus: 'RESERVED' },
  'order.cancelled': { qty: 1, fromStatus: 'PENDING_PAYMENT' },
  'order.rejected': { qty: 1, reason: 'SOLD_OUT' },
};

export interface EventIds {
  readonly orderId?: string;
  readonly productId?: string;
  readonly orderVersion?: number;
}

/** A valid envelope of `type` with fresh ids, unless given. */
export function testEvent<T extends OrderEventType>(type: T, ids: EventIds = {}): OrderEventOf<T> {
  // The generic `type` cannot narrow the union by itself; the shape matches OrderEventOf<T> by construction.
  return {
    eventId: randomUUID(),
    schemaVersion: ORDER_EVENT_SCHEMA_VERSION,
    occurredAt: new Date().toISOString(),
    orderId: ids.orderId ?? randomUUID(),
    orderVersion: ids.orderVersion ?? 1,
    productId: ids.productId ?? randomUUID(),
    dropId: randomUUID(),
    userId: randomUUID(),
    type,
    data: SAMPLE_DATA[type],
  } as OrderEventOf<T>;
}

export interface CapturedLogger {
  readonly logger: Logger;
  /** Every line logged so far, parsed. */
  readonly lines: Record<string, unknown>[];
  /** The alert lines with this `alertName`. */
  alerts(name: string): Record<string, unknown>[];
}

export function captureLogger(): CapturedLogger {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    { name: 'messaging-test', level: 'debug' },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { logger, lines, alerts: (name) => lines.filter((line) => line.alertName === name) };
}
