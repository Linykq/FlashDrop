import { randomUUID } from 'node:crypto';
import { KafkaEnv, loadEnv } from '@flashdrop/config';
import type { DashboardTotalsMessage, OrderEvent } from '@flashdrop/contracts';
import { DASHBOARD_CONSUMER, projectSalesEvents, readAllSalesTotals, sql } from '@flashdrop/db';
import { createTestDatabase, type TestDatabase } from '@flashdrop/db/testing';
import { createKafka, createProducer } from '@flashdrop/messaging';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConsumersRunningError, HistoryLostError, rebuildDashboardProjection } from './dashboard-rebuild';

/*
 * The steps of `dash:rebuild` against Compose Postgres (a throwaway database) and Kafka (a throwaway topic
 * and group, never `sales-dashboard`): it refuses while the group has a member, and otherwise deletes the
 * group's offsets and zeroes the projection at a higher version; and it refuses, before changing anything, once
 * retention has deleted the start of the topic.
 */

const { KAFKA_BROKERS } = loadEnv([KafkaEnv]);
const kafka = createKafka({ brokers: KAFKA_BROKERS, clientId: 'dash-rebuild-test', logLevel: 'error' });
const admin = kafka.admin();
const suffix = randomUUID();
const topic = `fdtest.dash-rebuild.${suffix}`;
/** A topic whose partition 1 no longer starts at offset 0, as after retention. */
const truncatedTopic = `fdtest.dash-rebuild.truncated.${suffix}`;
const groupId = `fdtest.dash-rebuild.group.${suffix}`;
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await admin.connect();
  await admin.createTopics({
    topics: [
      { topic, numPartitions: 1, replicationFactor: 1 },
      { topic: truncatedTopic, numPartitions: 2, replicationFactor: 1 },
    ],
  });
});

afterAll(async () => {
  await admin.deleteGroups([groupId]).catch(() => undefined);
  await admin.deleteTopics({ topics: [topic, truncatedTopic] }).catch(() => undefined);
  await admin.disconnect();
  await database?.drop();
});

const DROP = randomUUID();

function paid(): OrderEvent {
  return {
    eventId: randomUUID(),
    schemaVersion: 1,
    occurredAt: '2026-10-09T18:00:00.000Z',
    orderId: randomUUID(),
    orderVersion: 3,
    productId: randomUUID(),
    dropId: DROP,
    userId: randomUUID(),
    type: 'order.paid',
    data: { qty: 2, totalCents: 3_998, pspChargeId: `ch_${randomUUID()}` },
  };
}

async function rowCount(table: 'sales_minute' | 'processed_events'): Promise<number> {
  const { rows } = await database.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}
        WHERE ${table === 'processed_events' ? sql`consumer = ${DASHBOARD_CONSUMER}` : sql`true`}`,
  );
  return rows[0]?.n ?? 0;
}

describe('rebuildDashboardProjection', () => {
  it('refuses while a consumer is in the group, then resets offsets and zeroes the projection', async () => {
    await projectSalesEvents(database.db, [paid(), paid(), paid()]);
    const before = await readAllSalesTotals(database.db);
    const published: [string, DashboardTotalsMessage][] = [];
    const rebuild = () =>
      rebuildDashboardProjection({
        db: database.db,
        admin,
        groupId,
        topic,
        publish: async (dropId, message) => void published.push([dropId, message]),
      });

    const consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning: true } });
    await consumer.connect();
    try {
      await consumer.subscribe({ topics: [topic] });
      await consumer.run({ eachMessage: async () => undefined });
      await vi.waitFor(
        async () => {
          const { groups } = await admin.describeGroups([groupId]);
          expect(groups[0]?.members.length).toBe(1);
        },
        { timeout: 30_000, interval: 200 },
      );

      await expect(rebuild()).rejects.toThrow(ConsumersRunningError);
      expect(await readAllSalesTotals(database.db)).toEqual(before);
      expect(published).toEqual([]);
    } finally {
      await consumer.disconnect();
    }

    const zeroed = await rebuild();

    const version = before.get(DROP)?.version ?? 0;
    expect(zeroed.get(DROP)).toMatchObject({ version: version + 1, totals: { paid: 0, unitsSold: 0 } });
    expect(published).toEqual([[DROP, zeroed.get(DROP)]]);
    expect(await rowCount('sales_minute')).toBe(0);
    expect(await rowCount('processed_events')).toBe(0);
    const { groups } = await admin.describeGroups([groupId]);
    expect(groups[0]?.members ?? []).toEqual([]);

    // A second run finds no group offsets left to delete, and zeroes again at a higher version.
    expect((await rebuild()).get(DROP)?.version).toBe(version + 2);
  });

  it('refuses while retention has cut the topic short, unless told to accept the loss', async () => {
    const producer = createProducer(kafka);
    await producer.connect();
    try {
      await producer.send({
        topic: truncatedTopic,
        messages: [
          { partition: 1, value: 'lost' },
          { partition: 1, value: 'kept' },
        ],
      });
    } finally {
      await producer.disconnect();
    }
    // What retention does to the oldest segment: the partition now starts at offset 1.
    await admin.deleteTopicRecords({ topic: truncatedTopic, partitions: [{ partition: 1, offset: '1' }] });
    await projectSalesEvents(database.db, [paid()]);
    const before = await readAllSalesTotals(database.db);
    const published: string[] = [];
    const rebuild = (acceptHistoryLoss: boolean) =>
      rebuildDashboardProjection({
        db: database.db,
        admin,
        groupId,
        topic: truncatedTopic,
        acceptHistoryLoss,
        publish: async (dropId) => void published.push(dropId),
      });

    await expect(rebuild(false)).rejects.toThrow(HistoryLostError);
    await expect(rebuild(false)).rejects.toThrow('partitions 1 (starts at offset 1)');
    expect(await readAllSalesTotals(database.db)).toEqual(before);
    expect(await rowCount('processed_events')).toBeGreaterThan(0);
    expect(published).toEqual([]);

    const zeroed = await rebuild(true);

    expect(zeroed.get(DROP)?.totals.paid).toBe(0);
    expect(await rowCount('processed_events')).toBe(0);
  });
});
