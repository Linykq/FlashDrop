import { describe, expect, it } from 'vitest';
import {
  canTransition,
  INITIAL_ORDER_STATUSES,
  isTerminalOrderStatus,
  LIVE_ORDER_STATUSES,
  ORDER_TRANSITIONS,
  TERMINAL_ORDER_STATUSES,
} from './order-state';
import { ORDER_STATUSES, type OrderStatus } from './statuses';

// The §4.4 table, written out independently of ORDER_TRANSITIONS.
const LEGAL = new Set([
  'RESERVED>PENDING_PAYMENT',
  'RESERVED>EXPIRED',
  'RESERVED>CANCELLED',
  'PENDING_PAYMENT>PAID',
  'PENDING_PAYMENT>PAYMENT_FAILED',
  'PENDING_PAYMENT>EXPIRED',
  'PENDING_PAYMENT>CANCELLED',
]);

const pairs = ORDER_STATUSES.flatMap((from) => ORDER_STATUSES.map((to) => [from, to] as const));

describe('order state machine', () => {
  it.each(pairs)('%s -> %s follows §4.4', (from, to) => {
    expect(canTransition(from, to)).toBe(LEGAL.has(`${from}>${to}`));
  });

  it('never leaves a terminal status', () => {
    for (const status of TERMINAL_ORDER_STATUSES) {
      expect(ORDER_TRANSITIONS[status]).toEqual([]);
      expect(isTerminalOrderStatus(status)).toBe(true);
    }
  });

  it('splits every status into live or terminal', () => {
    const live: readonly OrderStatus[] = LIVE_ORDER_STATUSES;
    for (const status of ORDER_STATUSES) {
      expect(live.includes(status)).toBe(!isTerminalOrderStatus(status));
    }
  });

  it('inserts only holds and tombstones', () => {
    expect(INITIAL_ORDER_STATUSES).toEqual(['RESERVED', 'REJECTED']);
  });
});
