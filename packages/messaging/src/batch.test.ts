import pLimit from 'p-limit';
import { describe, expect, it } from 'vitest';
import { groupInOrder, type MessageOutcome, runUnits } from './batch';

interface Msg {
  readonly offset: number;
  readonly order: string;
}

const msgs = (...orders: string[]): Msg[] => orders.map((order, offset) => ({ offset, order }));
const done: MessageOutcome = { kind: 'done' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
const down = (): MessageOutcome => ({ kind: 'retry', reason: 'transient', error: new Error('down') });
const BUDGET = 3;

describe('groupInOrder', () => {
  it('keeps log order inside each order and orders groups by their first message', () => {
    const groups = groupInOrder(msgs('a', 'b', 'a', 'c', 'b', 'a'), (m) => m.order);

    expect(groups.map((group) => group.map((m) => m.offset))).toEqual([[0, 2, 5], [1, 4], [3]]);
  });

  it('puts duplicates of one order in one group', () => {
    expect(groupInOrder(msgs('x', 'x'), (m) => m.order)).toHaveLength(1);
  });
});

describe('runUnits', () => {
  it('runs one order sequentially and different orders concurrently, within the limit', async () => {
    const units = groupInOrder(msgs('a', 'b', 'a', 'c', 'b', 'a', 'd', 'e'), (m) => m.order);
    const active = new Map<string, number>();
    let inFlight = 0;
    let maxInFlight = 0;
    const started: number[] = [];

    const result = await runUnits(units, {
      limit: pLimit(3),
      mayStart: () => true,
      retryBudget: BUDGET,
      work: async (m) => {
        const sameOrder = active.get(m.order) ?? 0;
        expect(sameOrder, `order ${m.order} ran twice at once`).toBe(0);
        active.set(m.order, sameOrder + 1);
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        started.push(m.offset);
        await tick();
        inFlight--;
        active.set(m.order, 0);
        return done;
      },
    });

    expect(result.retry).toBeUndefined();
    expect(result.done.size).toBe(8);
    expect(maxInFlight).toBe(3);
    // Within order a: 0 before 2 before 5.
    expect(started.indexOf(0)).toBeLessThan(started.indexOf(2));
    expect(started.indexOf(2)).toBeLessThan(started.indexOf(5));
  });

  it('stops an order at its failed message while the other orders carry on', async () => {
    const units = groupInOrder(msgs('a', 'a', 'b', 'c', 'b'), (m) => m.order);
    const ran: number[] = [];

    const result = await runUnits(units, {
      limit: pLimit(1),
      mayStart: () => true,
      retryBudget: BUDGET,
      work: async (m) => {
        ran.push(m.offset);
        return m.offset === 0 ? down() : done;
      },
    });

    // a's second message waits for its first; b and c finish, so their commit only waits for a's.
    expect(ran).toEqual([0, 2, 4, 3]);
    expect([...result.done].map((m) => m.offset).sort()).toEqual([2, 3, 4]);
    expect(result.retry?.reason).toBe('transient');
    expect(result.retries).toBe(1);
  });

  it('keeps every other order of a payment-sized batch going when one charge fails transiently', async () => {
    const orders = Array.from({ length: 40 }, (_, i) => `o${i}`);
    const units = groupInOrder(msgs(...orders, ...orders), (m) => m.order);
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await runUnits(units, {
      limit: pLimit(8),
      mayStart: () => true,
      retryBudget: BUDGET,
      work: async (m) => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await tick();
        inFlight--;
        return m.order === 'o0' ? down() : done;
      },
    });

    // o0's two messages: the first failed, the second waits. Everything else finished at full concurrency.
    expect(result.done.size).toBe(78);
    expect(result.retries).toBe(1);
    expect(maxInFlight).toBe(8);
  });

  it('starts no message once the batch has spent its retry budget, finishing those in flight', async () => {
    const units = groupInOrder(msgs('a', 'b', 'c', 'd', 'e', 'f'), (m) => m.order);
    const ran: number[] = [];

    const result = await runUnits(units, {
      limit: pLimit(1),
      mayStart: () => true,
      retryBudget: BUDGET,
      work: async (m) => {
        ran.push(m.offset);
        // An outage: every call fails. Only the budget's worth are tried.
        return down();
      },
    });

    expect(ran).toEqual([0, 1, 2]);
    expect(result.done.size).toBe(0);
    expect(result.retries).toBe(BUDGET);
  });

  it('lets messages in flight finish when the budget runs out', async () => {
    const units = groupInOrder(msgs('a', 'b', 'b'), (m) => m.order);
    const result = await runUnits(units, {
      limit: pLimit(2),
      mayStart: () => true,
      retryBudget: 1,
      work: async (m) => {
        if (m.offset === 0) return down();
        await tick();
        return done;
      },
    });

    // b's first message was already running and finished; its second never started.
    expect([...result.done].map((m) => m.offset)).toEqual([1]);
  });

  it('starts no message once the deadline passed, finishing those in flight', async () => {
    let open = true;
    const units = groupInOrder(msgs('a', 'a', 'a'), (m) => m.order);
    const result = await runUnits(units, {
      limit: pLimit(1),
      mayStart: () => open,
      retryBudget: BUDGET,
      work: async () => {
        open = false; // the deadline passes during the first message
        await tick();
        return done;
      },
    });

    expect(result.done.size).toBe(1);
    expect(result.retry).toBeUndefined();
  });

  it('turns a rejected work promise into an unclassified retry', async () => {
    const result = await runUnits([[{ offset: 0, order: 'a' }]], {
      limit: pLimit(1),
      mayStart: () => true,
      retryBudget: BUDGET,
      work: () => Promise.reject(new Error('bug')),
    });

    expect(result.retry?.reason).toBe('unclassified');
  });
});
