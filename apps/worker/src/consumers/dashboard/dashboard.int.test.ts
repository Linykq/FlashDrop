import { randomUUID } from 'node:crypto';
import { KafkaEnv, loadEnv, ORDERS_PARTITIONS } from '@flashdrop/config';
import { DashboardTotalsMessage, OrderEvent } from '@flashdrop/contracts';
import {
  cancelOrder,
  DASHBOARD_CONSUMER,
  markPaid,
  markPaymentFailed,
  PgTimestamp,
  readDashboardCheck,
  readSalesMinutes,
  readSalesTotals,
  resetSalesProjection,
  sql,
} from '@flashdrop/db';
import { createSubscriber, dashboardChannel } from '@flashdrop/inventory';
import {
  type ConsumerRunner,
  createKafka,
  createPublisher,
  dispatchOrderEvent,
  type OrderEventHandlers,
  outboxRecord,
  type Publisher,
} from '@flashdrop/messaging';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expireOrders } from '../../sweeper/expire-orders';
import {
  armDrop,
  createDrop,
  createUsers,
  createWorkerTestEnv,
  lapse,
  placeOrder,
  reserve,
  type WorkerTestEnv,
} from '../../test/harness';
import { startConsumer } from '../index';
import { dashboardHandlers } from './index';

/*
 * The sales-dashboard consumer (design §9) against the Compose Postgres (a database of this file's own), the
 * tests' Redis and, for the runner, Kafka on a throwaway topic and group, never `orders.v1`. The events are
 * the real outbox rows of real order flows: each test's drop gets purchases, a declined payment, an expired
 * hold and a cancelled checkout.
 */

const { KAFKA_BROKERS } = loadEnv([KafkaEnv]);
let env: WorkerTestEnv;

beforeAll(async () => {
  env = await createWorkerTestEnv();
});

afterAll(async () => {
  await env?.close();
});

const context = () => ({ logger: env.deps.logger });

/** A drop with a little of everything, and the events its orders wrote, in outbox order. */
async function dropWithHistory(): Promise<{ dropId: string; events: OrderEvent[] }> {
  const dropId = await createDrop(env, { total: 20, limit: 3 });
  await armDrop(env, dropId);
  const users = await createUsers(env.db, 6);
  const [a = '', b = '', c = '', d = '', e = '', f = ''] = users;
  for (const [userId, qty] of [
    [a, 1],
    [b, 2],
    [c, 3],
  ] as const) {
    const orderId = await placeOrder(env, dropId, userId, { qty });
    await markPaid(env.db, { orderId, pspChargeId: `ch_${orderId}` });
  }
  const declined = await placeOrder(env, dropId, d, { paymentMethod: 'pm_decline' });
  await markPaymentFailed(env.db, {
    orderId: declined,
    declineCode: 'card_declined',
    pspChargeId: `ch_${declined}`,
  });
  await lapse(env, await reserve(env, dropId, e));
  await expireOrders(env.deps);
  await cancelOrder(env.db, { orderId: await placeOrder(env, dropId, f), userId: f });

  const { rows } = await env.db.execute<{ payload: unknown }>(
    sql`SELECT payload FROM outbox WHERE payload->>'dropId' = ${dropId} ORDER BY id`,
  );
  return { dropId, events: rows.map((row) => OrderEvent.parse(row.payload)) };
}

/** The projection equals the Postgres truth of the drop's orders, and its minutes add up to its totals. */
async function expectProjectionMatchesOrders(dropId: string) {
  const check = await readDashboardCheck(env.db, dropId);
  expect(check.totals).toEqual(check.truth);
  expect(check.minutes).toEqual(check.totals);
  expect(check.eventless).toBe(0);
  return check;
}

async function processedCount(eventIds: readonly string[]): Promise<number> {
  const { rows } = await env.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM processed_events
    WHERE consumer = ${DASHBOARD_CONSUMER} AND event_id = ANY(${sql.param([...eventIds])}::uuid[])`);
  return rows[0]?.n ?? 0;
}

const shuffle = <T>(items: readonly T[]): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
};

const deliver = (handlers: OrderEventHandlers, events: readonly OrderEvent[]) =>
  Promise.all(events.map((event) => dispatchOrderEvent(handlers, event, context())));

describe('sales-dashboard handlers', () => {
  it('fold every event once, however often and in whatever order it is delivered', async () => {
    const { dropId, events } = await dropWithHistory();
    const pushed: DashboardTotalsMessage[] = [];
    const subscriber = createSubscriber(env.redis, { name: 'dashboard-test-sub', logger: env.deps.logger });
    await subscriber.connect();
    try {
      await subscriber.subscribe(dashboardChannel(dropId), (message) =>
        pushed.push(DashboardTotalsMessage.parse(JSON.parse(message))),
      );
      const handlers = dashboardHandlers(env.deps);

      // Three copies of each event, shuffled, with copies inside one transaction and across several.
      await deliver(handlers, shuffle([...events, ...events]));
      for (const event of shuffle(events)) await dispatchOrderEvent(handlers, event, context());

      const check = await expectProjectionMatchesOrders(dropId);
      expect(check.totals).toEqual({
        reserved: 6,
        placed: 5,
        paid: 3,
        failed: 1,
        expired: 1,
        cancelled: 1,
        rejected: 0,
        unitsSold: 6,
        revenueCents: 6 * 1_999,
      });
      expect(await processedCount(events.map((event) => event.eventId))).toBe(events.length);
      // Every commit and every all-duplicate batch republishes; the last frame is the committed state.
      const latest = await readSalesTotals(env.db, dropId);
      await vi.waitFor(() => expect(pushed.at(-1)).toEqual(latest));
      expect(pushed.map((frame) => frame.version)).toEqual(
        [...pushed.map((frame) => frame.version)].sort((x, y) => x - y),
      );
    } finally {
      await subscriber.close();
    }
  });

  it('fold each event once when two consumers race over the same batch (a zombie and its replacement)', async () => {
    const { dropId, events } = await dropWithHistory();
    const zombie = dashboardHandlers(env.deps);
    const replacement = dashboardHandlers(env.deps);

    await Promise.all([deliver(zombie, shuffle(events)), deliver(replacement, shuffle(events))]);

    await expectProjectionMatchesOrders(dropId);
    expect(await processedCount(events.map((event) => event.eventId))).toBe(events.length);
  });

  it('give identical totals and minutes after the projection is wiped and every event replayed', async () => {
    const { dropId, events } = await dropWithHistory();
    const handlers = dashboardHandlers(env.deps);
    await deliver(handlers, events);
    const before = await readSalesTotals(env.db, dropId);
    const minutes = await readSalesMinutes(env.db, dropId);

    const zeroed = (await resetSalesProjection(env.db)).get(dropId);
    expect(zeroed?.version).toBe(before.version + 1);
    expect(zeroed?.totals.paid).toBe(0);
    await deliver(handlers, shuffle(events));

    const after = await readSalesTotals(env.db, dropId);
    expect(after.totals).toEqual(before.totals);
    expect(after.version).toBeGreaterThan(before.version + 1);
    expect(await readSalesMinutes(env.db, dropId)).toEqual(minutes);
    await expectProjectionMatchesOrders(dropId);
  });
});

describe('sales-dashboard group through Kafka', () => {
  const suffix = randomUUID();
  const topic = `fdtest.dashboard.orders.${suffix}`;
  const dlqTopic = `fdtest.dashboard.dlq.${suffix}`;
  const groupId = `fdtest.dashboard.group.${suffix}`;
  const kafka = createKafka({ brokers: KAFKA_BROKERS, clientId: 'dashboard-test', logLevel: 'error' });
  const admin = kafka.admin();
  let publisher: Publisher;
  let runner: ConsumerRunner | undefined;

  beforeAll(async () => {
    await admin.connect();
    await admin.createTopics({
      topics: [
        { topic, numPartitions: ORDERS_PARTITIONS, replicationFactor: 1 },
        { topic: dlqTopic, numPartitions: 1, replicationFactor: 1 },
      ],
    });
    publisher = createPublisher({ kafka, logger: env.deps.logger });
  });

  afterAll(async () => {
    await runner?.stop();
    await publisher?.close();
    await admin.deleteGroups([groupId]).catch(() => undefined);
    await admin.deleteTopics({ topics: [topic, dlqTopic] }).catch(() => undefined);
    await admin.disconnect();
  });

  async function startGroup(): Promise<ConsumerRunner> {
    const started = await startConsumer('dashboard', env.deps, {
      kafka,
      dlq: publisher,
      topic,
      dlqTopic,
      groupId,
      backoff: { baseMs: 50, capMs: 500 },
    });
    await vi.waitFor(() => expect(started.health().healthy).toBe(true), { timeout: 30_000, interval: 100 });
    return started;
  }

  async function publishOutbox(dropId: string): Promise<void> {
    const { rows } = await env.db.execute<{
      id: string;
      event_id: string;
      partition_key: string;
      event_type: string;
      payload: Record<string, unknown>;
      headers: Record<string, string>;
      created_at: string;
    }>(sql`SELECT id::text, event_id, partition_key, event_type, payload, headers, created_at::text
           FROM outbox WHERE payload->>'dropId' = ${dropId} ORDER BY id`);
    await publisher.publish(
      rows.map((row) =>
        outboxRecord({
          id: row.id,
          eventId: row.event_id,
          topic,
          partitionKey: row.partition_key,
          eventType: row.event_type,
          payload: row.payload,
          headers: row.headers,
          createdAt: PgTimestamp.parse(row.created_at),
        }),
      ),
    );
  }

  const caughtUp = async (dropId: string) => {
    const check = await readDashboardCheck(env.db, dropId);
    expect(check.totals).toEqual(check.truth);
  };

  it('folds duplicates once, and a wiped projection replayed from the earliest offset converges to the same numbers', async () => {
    const { dropId } = await dropWithHistory();
    // The relay's crash between send and mark publishes a batch twice (§5.4).
    await publishOutbox(dropId);
    await publishOutbox(dropId);
    runner = await startGroup();
    await vi.waitFor(() => caughtUp(dropId), { timeout: 30_000, interval: 200 });
    const before = await readSalesTotals(env.db, dropId);
    const minutes = await readSalesMinutes(env.db, dropId);

    // dash:rebuild (§9): consumers stopped, the group's offsets gone (earliest again), the projection zeroed.
    await runner.stop();
    runner = undefined;
    await admin.deleteGroups([groupId]);
    await resetSalesProjection(env.db);
    expect((await readSalesTotals(env.db, dropId)).totals.paid).toBe(0);
    runner = await startGroup();

    await vi.waitFor(() => caughtUp(dropId), { timeout: 30_000, interval: 200 });
    const after = await readSalesTotals(env.db, dropId);
    expect(after.totals).toEqual(before.totals);
    expect(after.version).toBeGreaterThan(before.version);
    expect(await readSalesMinutes(env.db, dropId)).toEqual(minutes);
    await expectProjectionMatchesOrders(dropId);
  });
});
