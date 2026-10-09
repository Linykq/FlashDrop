import { outboxOf, readPartition } from '../../../tools/system/support';
import type { ChaosContext } from '../harness';

/*
 * INV-5 from the broker's side, for the burst's own orders: every outbox row reached `orders.v1`, nothing
 * reached it that the outbox never held, and how many copies of each event the consumer groups were sent
 * (more than one after a relay crash between send and mark, two in dup-delivery mode).
 */

export interface Delivery {
  /** The burst's outbox events. */
  readonly events: number;
  readonly unpublished: number;
  /** Their records on the drop's partition since the burst began. */
  readonly records: number;
  /** Outbox events with no record. */
  readonly missing: readonly string[];
  /** Records whose event the outbox never held. */
  readonly unknown: readonly string[];
  /** How many events were delivered n times, by n. */
  readonly copies: Readonly<Record<string, number>>;
}

export async function deliveryOf(ctx: ChaosContext, orderIds: readonly string[]): Promise<Delivery> {
  const outbox = await outboxOf(ctx.stores.pool, orderIds);
  const orders = new Set(orderIds);
  const records = (await readPartition(ctx.stores, ctx.partition, ctx.partitionFrom)).filter((record) =>
    orders.has(record.event.orderId),
  );
  const delivered = new Map<string, number>();
  for (const { event } of records) delivered.set(event.eventId, (delivered.get(event.eventId) ?? 0) + 1);
  const held = new Set(outbox.map((row) => row.event_id));
  const copies: Record<string, number> = {};
  for (const row of outbox) {
    const n = String(delivered.get(row.event_id) ?? 0);
    copies[n] = (copies[n] ?? 0) + 1;
  }
  return {
    events: outbox.length,
    unpublished: outbox.filter((row) => !row.published).length,
    records: records.length,
    missing: outbox.filter((row) => !delivered.has(row.event_id)).map((row) => row.event_id),
    unknown: [...delivered.keys()].filter((eventId) => !held.has(eventId)),
    copies,
  };
}

/** The problems with a delivery in which every event must have reached the broker `minCopies` times or more. */
export function deliveryProblems(delivery: Delivery, minCopies: number): string[] {
  const problems: string[] = [];
  if (delivery.events === 0) problems.push('the burst wrote no outbox events');
  if (delivery.unpublished > 0) problems.push(`${delivery.unpublished} outbox rows never published`);
  if (delivery.missing.length > 0) {
    problems.push(
      `${delivery.missing.length} events never reached orders.v1: ${delivery.missing.slice(0, 3)}`,
    );
  }
  if (delivery.unknown.length > 0) {
    problems.push(
      `${delivery.unknown.length} records the outbox never held: ${delivery.unknown.slice(0, 3)}`,
    );
  }
  const short = Object.entries(delivery.copies)
    .filter(([n]) => Number(n) < minCopies)
    .reduce((sum, [, events]) => sum + events, 0);
  if (short > 0 && minCopies > 1)
    problems.push(`${short} events were delivered fewer than ${minCopies} times`);
  return problems;
}
