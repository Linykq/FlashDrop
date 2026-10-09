import { KafkaJS } from '@confluentinc/kafka-javascript';
import { describe, expect, it, vi } from 'vitest';
import { classifyPublishFailure, createPublisher, PublishError } from './publisher';

const codes = KafkaJS.ErrorCodes;
const kafkaError = (code: number, message = 'x') => new KafkaJS.KafkaJSError(message, { code });

describe('classifyPublishFailure', () => {
  // Observed in the M0 spike with the broker paused: code -192, retriable false.
  it('reads an unacknowledged send as a timeout', () => {
    expect(classifyPublishFailure(kafkaError(codes.ERR__MSG_TIMED_OUT, 'Local: Message timed out'))).toBe(
      'timeout',
    );
    expect(classifyPublishFailure(kafkaError(codes.ERR_REQUEST_TIMED_OUT))).toBe('timeout');
  });

  it('reads a lost idempotent producer as fatal, by code or by flag', () => {
    expect(classifyPublishFailure(kafkaError(codes.ERR__FATAL))).toBe('fatal');
    expect(classifyPublishFailure({ code: codes.ERR_UNKNOWN, isFatal: true })).toBe('fatal');
  });

  it('reads a refused record as rejected', () => {
    expect(classifyPublishFailure(kafkaError(codes.ERR__UNKNOWN_TOPIC))).toBe('rejected');
    expect(classifyPublishFailure(kafkaError(codes.ERR_UNKNOWN_TOPIC_OR_PART))).toBe('rejected');
    expect(classifyPublishFailure(kafkaError(codes.ERR_MSG_SIZE_TOO_LARGE))).toBe('rejected');
  });

  it('reads connection trouble and anything unknown as unavailable', () => {
    expect(classifyPublishFailure(kafkaError(codes.ERR__TRANSPORT))).toBe('unavailable');
    expect(classifyPublishFailure(kafkaError(codes.ERR__ALL_BROKERS_DOWN))).toBe('unavailable');
    expect(classifyPublishFailure(kafkaError(codes.ERR__QUEUE_FULL))).toBe('unavailable');
    expect(classifyPublishFailure(new Error('no code'))).toBe('unavailable');
  });
});

describe('PublishError', () => {
  it('is transient unless Kafka refused the record', () => {
    const timedOut = new PublishError(
      kafkaError(codes.ERR__MSG_TIMED_OUT, 'Local: Message timed out'),
      3,
      10,
    );
    expect(timedOut).toMatchObject({ kind: 'timeout', transient: true, failed: 3, total: 10 });
    expect(timedOut.code).toBe(codes.ERR__MSG_TIMED_OUT);
    expect(timedOut.message).toBe(
      '3 of 10 records not published (timeout): KafkaJSError: Local: Message timed out',
    );

    expect(new PublishError(kafkaError(codes.ERR__UNKNOWN_TOPIC), 1, 1).transient).toBe(false);
  });
});

describe('createPublisher', () => {
  /** A client whose producers connect when the test says so, recording what happens to them. */
  function slowKafka() {
    const connecting = Promise.withResolvers<void>();
    const producer = { connect: () => connecting.promise, disconnect: vi.fn(async () => undefined) };
    // The fake carries the one method the publisher calls; the rest of the client type is unused.
    const kafka = { producer: () => producer } as unknown as KafkaJS.Kafka;
    return { kafka, producer, connecting };
  }

  it('gives up on a connect after its bound, and drops that producer once the client settles it', async () => {
    const { kafka, producer, connecting } = slowKafka();
    const warnings: unknown[] = [];
    const publisher = createPublisher({
      kafka,
      logger: { warn: (o: unknown) => void warnings.push(o) },
      connectTimeoutMs: 20,
    });

    const started = Date.now();
    const error = await publisher.ready().catch((e: unknown) => e);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error).toBeInstanceOf(PublishError);
    expect(error).toMatchObject({ kind: 'unavailable', transient: true });
    expect((error as PublishError).message).toBe(
      'producer not connected (unavailable): ConnectTimeoutError: kafka producer did not connect within 20 ms',
    );
    // The client finally connects the abandoned producer: it is disconnected, never used.
    connecting.resolve();
    await vi.waitFor(() => expect(producer.disconnect).toHaveBeenCalledOnce());
    expect(warnings).toEqual([]);
  });

  it('refuses after close', async () => {
    const { kafka } = slowKafka();
    const publisher = createPublisher({ kafka, logger: { warn: () => undefined } });
    await publisher.close();
    await expect(publisher.ready()).rejects.toBeInstanceOf(PublishError);
  });
});
