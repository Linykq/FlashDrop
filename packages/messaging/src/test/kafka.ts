import { randomUUID } from 'node:crypto';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { KafkaEnv, loadEnv } from '@flashdrop/config';
import { onTestFinished } from 'vitest';
import { createKafka } from '../kafka';
import { compareOffsets, nextOffset } from '../offsets';

/*
 * Integration-test helpers on the shared Compose broker. Every test works on throwaway topics and groups
 * with unique names, never on `orders.v1` (the running stack's groups read it from the earliest offset), and
 * registers their deletion as soon as they exist.
 */

export function testKafka(clientId = 'messaging-test'): KafkaJS.Kafka {
  const { KAFKA_BROKERS } = loadEnv([KafkaEnv]);
  return createKafka({ brokers: KAFKA_BROKERS, clientId, logLevel: 'error' });
}

export const uniqueName = (prefix: string) => `fdtest.${prefix}.${randomUUID()}`;

/** A connected admin client, disconnected when the test finishes. */
export async function testAdmin(kafka: KafkaJS.Kafka): Promise<KafkaJS.Admin> {
  const admin = kafka.admin();
  await admin.connect();
  onTestFinished(() => admin.disconnect());
  return admin;
}

/** A fresh topic, deleted when the test finishes. */
export async function testTopic(admin: KafkaJS.Admin, prefix: string, partitions: number): Promise<string> {
  const topic = uniqueName(prefix);
  await admin.createTopics({ topics: [{ topic, numPartitions: partitions, replicationFactor: 1 }] });
  onTestFinished(() => admin.deleteTopics({ topics: [topic] }));
  return topic;
}

/** A fresh group id whose committed offsets are deleted when the test finishes (if it ever formed). */
export function testGroup(admin: KafkaJS.Admin, prefix: string): string {
  const groupId = uniqueName(prefix);
  onTestFinished(async () => {
    await admin.deleteGroups([groupId]).catch(() => undefined);
  });
  return groupId;
}

export interface ReadRecord {
  readonly partition: number;
  readonly offset: string;
  readonly key: string | null;
  readonly value: string | null;
  readonly headers: KafkaJS.IHeaders | undefined;
}

/** Every record of `topic` up to the end it has now, read by an ephemeral group that never commits. */
export async function readToEnd(
  kafka: KafkaJS.Kafka,
  admin: KafkaJS.Admin,
  topic: string,
): Promise<ReadRecord[]> {
  const watermarks = await admin.fetchTopicOffsets(topic);
  const ends = new Map(
    watermarks.filter((w) => compareOffsets(w.high, w.low) > 0).map((w) => [w.partition, w.high]),
  );
  if (ends.size === 0) return [];
  const records: ReadRecord[] = [];
  const consumer = kafka.consumer({
    kafkaJS: { groupId: uniqueName('reader'), fromBeginning: true, autoCommit: false },
  });
  const done = Promise.withResolvers<void>();
  const timer = setTimeout(() => done.reject(new Error(`could not read ${topic} to its end`)), 30_000);
  const seen = new Set<string>();
  await consumer.connect();
  try {
    await consumer.subscribe({ topics: [topic] });
    await consumer.run({
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, resolveOffset }) => {
        const end = ends.get(batch.partition);
        for (const message of batch.messages) {
          if (end === undefined || compareOffsets(message.offset, end) >= 0) break;
          const id = `${batch.partition}:${message.offset}`;
          if (!seen.has(id)) {
            seen.add(id);
            records.push({
              partition: batch.partition,
              offset: message.offset,
              key: message.key?.toString('utf8') ?? null,
              value: message.value?.toString('utf8') ?? null,
              headers: message.headers,
            });
          }
          resolveOffset(message.offset);
          if (nextOffset(message.offset) === end) ends.delete(batch.partition);
        }
        if (ends.size === 0) done.resolve();
      },
    });
    await done.promise;
  } finally {
    clearTimeout(timer);
    await consumer.disconnect();
  }
  return records.sort((a, b) => a.partition - b.partition || compareOffsets(a.offset, b.offset));
}
