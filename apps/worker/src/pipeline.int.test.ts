import { randomUUID } from 'node:crypto';
import { KafkaEnv, loadEnv, ORDERS_PARTITIONS, TOPICS } from '@flashdrop/config';
import { getOrder } from '@flashdrop/db';
import { readStock } from '@flashdrop/inventory';
import {
  type ConsumerRunner,
  createKafka,
  createPublisher,
  type Publisher,
  partitionForKey,
} from '@flashdrop/messaging';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startConsumer } from './consumers';
import { createPspClient } from './consumers/psp-client';
import { type RelayRole, startRelay } from './relay';
import { FAKE_PSP_API_KEY, type FakePsp, startFakePsp } from './test/fake-psp';
import {
  armDrop,
  createDrop,
  createUsers,
  createWorkerTestEnv,
  placeOrder,
  type WorkerTestEnv,
} from './test/harness';

/*
 * The M3/M4 path end to end (design §5.3, §16): checkout writes `order.placed`, the relay publishes it
 * keyed by productId, the payment group charges and pays the order, the relay publishes `order.paid`, and
 * the settlement group commits the units in Redis. Real relay, real runners, real Kafka, on a throwaway
 * topic and groups (the relay's records are re-addressed to it, so nothing reaches the stack's `orders.v1`),
 * a database of this file's own, and a PSP whose failures the test sets. The sweeper does not run, so stock
 * that comes back came through the settlement consumer, not the safety net.
 */

const { KAFKA_BROKERS } = loadEnv([KafkaEnv]);
const kafka = createKafka({ brokers: KAFKA_BROKERS, clientId: 'worker-pipeline-test', logLevel: 'error' });
const admin = kafka.admin();
const suffix = randomUUID();
const topic = `fdtest.worker.orders.${suffix}`;
const dlqTopic = `fdtest.worker.dlq.${suffix}`;
const groups = {
  payment: `fdtest.worker.payment.${suffix}`,
  settlement: `fdtest.worker.settlement.${suffix}`,
};

let env: WorkerTestEnv;
let psp: FakePsp;
let publisher: Publisher;
let relay: RelayRole | undefined;
let runners: ConsumerRunner[] = [];
const products = new Set<string>();

beforeAll(async () => {
  env = await createWorkerTestEnv();
  psp = await startFakePsp();
  await admin.connect();
  await admin.createTopics({
    topics: [
      { topic, numPartitions: ORDERS_PARTITIONS, replicationFactor: 1 },
      { topic: dlqTopic, numPartitions: 1, replicationFactor: 1 },
    ],
  });
  publisher = createPublisher({ kafka, logger: env.deps.logger });
  const toTestTopic: Publisher = {
    ready: () => publisher.ready(),
    publish: (records) =>
      publisher.publish(
        records.map((record) => (record.topic === TOPICS.orders ? { ...record, topic } : record)),
      ),
    close: async () => undefined,
  };
  relay = startRelay(env.deps, { databaseUrl: env.url, publisher: toTestTopic });
  const deps = {
    ...env.deps,
    psp: createPspClient({ baseUrl: psp.url, apiKey: FAKE_PSP_API_KEY, timeoutMs: 1_000 }),
  };
  const options = { kafka, dlq: publisher, topic, dlqTopic, backoff: { baseMs: 50, capMs: 500 } };
  runners = [
    await startConsumer('payment', deps, { ...options, groupId: groups.payment }),
    await startConsumer('settlement', deps, { ...options, groupId: groups.settlement }),
  ];
  // Healthy means assigned (§6.4): only then can a group receive the events.
  await vi.waitFor(() => expect(runners.map((runner) => runner.health().healthy)).toEqual([true, true]), {
    timeout: 30_000,
    interval: 100,
  });
});

afterAll(async () => {
  await Promise.allSettled([relay?.stop(), ...runners.map((runner) => runner.stop())]);
  await publisher?.close();
  await admin.deleteGroups(Object.values(groups)).catch(() => undefined);
  await admin.deleteTopics({ topics: [topic, dlqTopic] }).catch(() => undefined);
  await admin.disconnect();
  await psp?.close();
  await env?.close();
});

const WAIT = { timeout: 20_000, interval: 100 };

async function armedDrop() {
  const dropId = await createDrop(env, { total: 5, limit: 2 });
  await armDrop(env, dropId);
  const [drop] = await env.db.query.drops.findMany({ where: (d, { eq }) => eq(d.id, dropId), limit: 1 });
  if (drop !== undefined) products.add(drop.productId);
  const [userId = ''] = await createUsers(env.db, 1);
  return { dropId, userId };
}

describe('checkout to PAID through Kafka', () => {
  it('pays a placed order and commits its units in Redis', async () => {
    const { dropId, userId } = await armedDrop();
    const orderId = await placeOrder(env, dropId, userId);

    await vi.waitFor(async () => {
      const order = await getOrder(env.db, orderId);
      expect(order).toMatchObject({ status: 'PAID' });
      expect(order?.redisSettledAt).toBeInstanceOf(Date);
    }, WAIT);

    expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 4, held: 0, sold: 1 });
    expect(psp.charges(orderId)).toEqual([expect.objectContaining({ status: 'succeeded' })]);
  });

  it('gives a declined order’s stock back to Redis through the settlement consumer', async () => {
    const { dropId, userId } = await armedDrop();
    const orderId = await placeOrder(env, dropId, userId, { paymentMethod: 'pm_decline' });

    await vi.waitFor(async () => {
      expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'PAYMENT_FAILED' });
      expect(await readStock(env.redis, dropId)).toMatchObject({ avail: 5, held: 0, sold: 0 });
    }, WAIT);
  });

  it('rides out a PSP outage, paying the order once it is back, with one charge', async () => {
    const { dropId, userId } = await armedDrop();
    psp.failNext(4);
    const orderId = await placeOrder(env, dropId, userId);

    await vi.waitFor(
      async () => expect(await getOrder(env.db, orderId)).toMatchObject({ status: 'PAID' }),
      WAIT,
    );

    expect(psp.charges(orderId)).toHaveLength(1);
    expect(runners[0]?.health()).toMatchObject({ healthy: true, stuck: [] });
  });

  it('keys every event by productId: each product’s events sit on murmur2(productId) % 6, and nothing was dead-lettered', async () => {
    const used = new Set([...products].map((productId) => partitionForKey(productId, ORDERS_PARTITIONS)));
    const offsets = await admin.fetchTopicOffsets(topic);
    const withRecords = offsets.filter((p) => BigInt(p.high) > BigInt(p.low)).map((p) => p.partition);

    expect(withRecords.length).toBeGreaterThan(0);
    for (const partition of withRecords) expect(used).toContain(partition);
    const [dlq] = await admin.fetchTopicOffsets(dlqTopic);
    expect(dlq?.high).toBe('0');
  });
});
