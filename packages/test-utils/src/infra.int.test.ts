import { randomUUID } from 'node:crypto';
import { ORDERS_PARTITIONS, TOPICS } from '@flashdrop/config';
import { createKafka, createProducer, partitionForKey } from '@flashdrop/messaging';
import pg from 'pg';
import { createClient } from 'redis';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { loadInfraEnv } from './infra';

const env = loadInfraEnv();

describe('Postgres', () => {
  it('is the Compose PostgreSQL 17, with transaction_timeout', async () => {
    const client = new pg.Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ version: number; database: string }>(
        "select current_setting('server_version_num')::int as version, current_database() as database",
      );
      expect(rows[0]?.version).toBeGreaterThanOrEqual(170_000);
      expect(rows[0]?.version).toBeLessThan(180_000);
      expect(rows[0]?.database).toBe('flashdrop');

      // New in 17; it bounds the rebuild transaction (§4.7).
      await client.query("set transaction_timeout = '5s'");
      const timeout = await client.query<{ transaction_timeout: string }>('show transaction_timeout');
      expect(timeout.rows[0]?.transaction_timeout).toBe('5s');
    } finally {
      await client.end();
    }
  });
});

describe('Redis', () => {
  const redis = createClient({ url: env.REDIS_URL });
  // node-redis re-throws an 'error' event nobody listens to, which would crash the test worker. Collect
  // them instead and fail the test that was running.
  const errors: unknown[] = [];
  redis.on('error', (error: unknown) => errors.push(error));

  beforeAll(async () => {
    await redis.connect();
  });

  afterEach(() => {
    expect(errors.splice(0), 'Redis client errors').toEqual([]);
  });

  afterAll(async () => {
    await redis.close();
  });

  it('runs with infra/redis/redis.conf: AOF every second, 256 MB, no eviction', async () => {
    const config = await redis.configGet(['appendonly', 'appendfsync', 'maxmemory', 'maxmemory-policy']);

    expect(config).toEqual({
      appendonly: 'yes',
      appendfsync: 'everysec',
      maxmemory: String(256 * 1024 * 1024),
      'maxmemory-policy': 'noeviction',
    });
  });

  it('loads, calls and deletes a Functions library', async () => {
    const id = randomUUID().replaceAll('-', '');
    const library = `fdtest_${id}`;
    const fn = `${library}_incrby`;
    const key = `fdtest:{${id}}:counter`;
    const call = (amount: number) => redis.fCall(fn, { keys: [key], arguments: [String(amount)] });

    await redis.functionLoad(
      `#!lua name=${library}\n` +
        `redis.register_function('${fn}', function(keys, args) return redis.call('INCRBY', keys[1], args[1]) end)`,
    );
    try {
      expect(await call(5)).toBe(5);
      expect(await call(2)).toBe(7);
    } finally {
      await redis.functionDelete(library);
      await redis.del(key);
    }

    // Every process reloads the flashdrop library when it sees this error (§4.2).
    await expect(call(1)).rejects.toThrow(/Function not found/);
  });
});

describe('Kafka', () => {
  const DELIVERY_TIMEOUT_MS = 20_000;
  const kafka = createKafka({ brokers: env.KAFKA_BROKERS, clientId: 'flashdrop-infra-test' });
  const admin = kafka.admin();

  beforeAll(async () => {
    await admin.connect();
  });

  afterAll(async () => {
    await admin.disconnect();
  });

  it('has the topics kafka-init creates', async () => {
    const metadata = await admin.fetchTopicMetadata({ topics: [TOPICS.orders, TOPICS.ordersDlq] });
    const partitions = Object.fromEntries(metadata.map((topic) => [topic.name, topic.partitions.length]));

    expect(partitions).toEqual({ [TOPICS.orders]: ORDERS_PARTITIONS, [TOPICS.ordersDlq]: 1 });
  });

  it('delivers keyed messages on the partitions the Java producer would pick', async () => {
    // A throwaway topic shaped like orders.v1. Test records on orders.v1 itself would reach the real
    // consumer groups, which start from the earliest offset (§6.4).
    const topic = `fdtest.infra.${randomUUID()}`;
    const groupId = `fdtest-infra-${randomUUID()}`;
    const keys = ['prod-A', 'prod-B', ...Array.from({ length: 6 }, () => randomUUID())];

    // Each resource registers its cleanup as soon as it exists. Vitest runs them in reverse order, one by
    // one, even after a failure or a timeout, so a failing step can neither hide the test's own error nor
    // leak the topic.
    await admin.createTopics({ topics: [{ topic, numPartitions: ORDERS_PARTITIONS, replicationFactor: 1 }] });
    onTestFinished(() => admin.deleteTopics({ topics: [topic] }));

    const producer = createProducer(kafka);
    await producer.connect();
    onTestFinished(() => producer.disconnect());
    await producer.send({ topic, messages: keys.map((key) => ({ key, value: key })) });

    // The consumer mode of the runner in §6.4: earliest offset, eachBatch, manual commits.
    const consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning: true, autoCommit: false } });
    let committed = false;
    await consumer.connect();
    onTestFinished(async () => {
      await consumer.disconnect();
      // Committed offsets outlive the consumer, so the group must go too. DeleteGroups fails for a group
      // that never formed, which is why it waits for the first commit.
      if (committed) await admin.deleteGroups([groupId]);
    });
    await consumer.subscribe({ topics: [topic] });

    const partitionOf = new Map<string, number>();
    const delivered = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      const missing = keys.filter((key) => !partitionOf.has(key));
      delivered.reject(new Error(`Not delivered within ${DELIVERY_TIMEOUT_MS} ms: ${missing.join(', ')}`));
    }, DELIVERY_TIMEOUT_MS);
    onTestFinished(() => clearTimeout(timer));

    consumer
      .run({
        eachBatch: async ({ batch }) => {
          for (const message of batch.messages) {
            partitionOf.set(String(message.key), batch.partition);
          }
          const next = (BigInt(batch.lastOffset()) + 1n).toString();
          await consumer.commitOffsets([{ topic, partition: batch.partition, offset: next }]);
          committed = true;
          if (partitionOf.size === keys.length) delivered.resolve();
        },
      })
      .catch(delivered.reject);
    await delivered.promise;

    for (const key of keys) {
      expect(partitionOf.get(key), key).toBe(partitionForKey(key, ORDERS_PARTITIONS));
    }
  });
});
