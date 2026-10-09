import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Logger } from '@flashdrop/config';
import { describeError } from './errors';
import { createProducer } from './kafka';

/*
 * An awaitable publisher over the idempotent producer (design §5.4, §6.1). `publish` resolves once every
 * record is acknowledged by all in-sync replicas, and rejects only after every record has settled, so a
 * caller that rolls back on failure (the relay) never leaves copies queued in the client that a later
 * attempt would race. Each record is sent on its own call for that reason: the client's multi-message
 * `send` rejects on the first failure while the others are still in flight. librdkafka still batches them
 * on the wire (`linger.ms`).
 *
 * Connecting is bounded. The client's own connect gives up only after 30 s against an unreachable broker
 * (measured), longer than the relay's `transaction_timeout` (20 s), so the relay calls `ready()` before it
 * opens its batch transaction, and a broker outage is waited out with no rows locked. A connect that the
 * bound abandoned is disconnected once the client settles it.
 */

export interface OutgoingRecord {
  readonly topic: string;
  /** The partition key; `orders.v1` uses the productId (murmur2, §6.1). */
  readonly key: string | Buffer | null;
  readonly value: string | Buffer | null;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Why a send failed:
 * - `timeout`: not acknowledged within `message.timeout.ms` (a broker unreachable or overloaded);
 * - `unavailable`: no connection, no leader, too few in-sync replicas, or the client queue is full;
 * - `fatal`: the idempotent producer lost its sequence state; this publisher replaces the producer;
 * - `rejected`: Kafka refuses the record itself (unknown topic, too large, not authorized). Resending the
 *   same record will fail the same way until someone fixes the cause.
 */
export type PublishFailureKind = 'timeout' | 'unavailable' | 'fatal' | 'rejected';

export class PublishError extends Error {
  override name = 'PublishError';
  readonly kind: PublishFailureKind;
  /** Whether resending later can succeed without a human: everything but `rejected`. */
  readonly transient: boolean;
  /** The librdkafka error code of the first failure, when it had one. */
  readonly code: number | undefined;
  readonly failed: number;
  readonly total: number;

  constructor(cause: unknown, failed: number, total: number) {
    const kind = classifyPublishFailure(cause);
    // total 0: `ready()`, which publishes nothing and fails only to connect.
    const what = total === 0 ? 'producer not connected' : `${failed} of ${total} records not published`;
    super(`${what} (${kind}): ${describeError(cause)}`, { cause });
    this.kind = kind;
    this.transient = kind !== 'rejected';
    this.code = errorCode(cause);
    this.failed = failed;
    this.total = total;
  }
}

const codes = KafkaJS.ErrorCodes;

const TIMEOUT_CODES: ReadonlySet<number> = new Set([
  codes.ERR__MSG_TIMED_OUT,
  codes.ERR__TIMED_OUT,
  codes.ERR_REQUEST_TIMED_OUT,
]);

const REJECTED_CODES: ReadonlySet<number> = new Set([
  codes.ERR__UNKNOWN_TOPIC,
  codes.ERR_UNKNOWN_TOPIC_OR_PART,
  codes.ERR__UNKNOWN_PARTITION,
  codes.ERR_MSG_SIZE_TOO_LARGE,
  codes.ERR_RECORD_LIST_TOO_LARGE,
  codes.ERR_INVALID_MSG,
  codes.ERR_INVALID_RECORD,
  codes.ERR__INVALID_ARG,
  codes.ERR_TOPIC_AUTHORIZATION_FAILED,
]);

/** librdkafka errors carry a numeric `code` (KafkaJSError from delivery reports, LibrdKafkaError from produce). */
function errorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}

/**
 * A fatal producer error. librdkafka fails every queued and later message with `ERR__FATAL`; the flag is
 * `isFatal` on a `LibrdKafkaError` and `fatal` on a `KafkaJSError`, which does not always carry it over.
 */
function isFatal(error: unknown): boolean {
  if (errorCode(error) === codes.ERR__FATAL) return true;
  if (typeof error !== 'object' || error === null) return false;
  return ('fatal' in error && error.fatal === true) || ('isFatal' in error && error.isFatal === true);
}

export function classifyPublishFailure(error: unknown): PublishFailureKind {
  if (isFatal(error)) return 'fatal';
  const code = errorCode(error);
  if (code !== undefined && TIMEOUT_CODES.has(code)) return 'timeout';
  if (code !== undefined && REJECTED_CODES.has(code)) return 'rejected';
  return 'unavailable';
}

export interface Publisher {
  /**
   * Resolves once the producer is connected, connecting it if needed within `connectTimeoutMs`; otherwise
   * rejects with an `unavailable` `PublishError`. `publish` connects the same way, so this only moves the
   * wait to where the caller can afford it.
   */
  ready(): Promise<void>;
  /** Resolves when every record is acknowledged; otherwise rejects with `PublishError`, after all settled. */
  publish(records: readonly OutgoingRecord[]): Promise<void>;
  /** Disconnects; later publishes fail. */
  close(): Promise<void>;
}

export interface PublisherOptions {
  readonly kafka: KafkaJS.Kafka;
  readonly logger: Pick<Logger, 'warn'>;
  /** How long a connect may take before it counts as failed (default 8 s). */
  readonly connectTimeoutMs?: number;
}

export const PUBLISHER_CONNECT_TIMEOUT_MS = 8_000;

class ConnectTimeoutError extends Error {
  override name = 'ConnectTimeoutError';
}

/** A publisher that connects on first use and replaces its producer after a fatal error. */
export function createPublisher({
  kafka,
  logger,
  connectTimeoutMs = PUBLISHER_CONNECT_TIMEOUT_MS,
}: PublisherOptions): Publisher {
  let current: Promise<KafkaJS.Producer> | undefined;
  let closed = false;

  const connect = async (): Promise<KafkaJS.Producer> => {
    const producer = createProducer(kafka);
    const connecting = producer.connect();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ConnectTimeoutError(`kafka producer did not connect within ${connectTimeoutMs} ms`)),
        connectTimeoutMs,
      );
    });
    try {
      await Promise.race([connecting, timeout]);
      return producer;
    } catch (err) {
      // The client keeps connecting after the bound; drop this producer once it has settled either way.
      void connecting.then(
        () =>
          producer
            .disconnect()
            .catch((disconnectErr: unknown) =>
              logger.warn({ err: disconnectErr }, 'abandoned kafka producer did not disconnect cleanly'),
            ),
        () => undefined,
      );
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  const connected = (): Promise<KafkaJS.Producer> => {
    if (current !== undefined) return current;
    const connecting = connect();
    current = connecting;
    // A failed connect is retried by the next publish instead of being cached.
    connecting.catch(() => {
      if (current === connecting) current = undefined;
    });
    return connecting;
  };

  const retire = (instance: Promise<KafkaJS.Producer>) => {
    if (current === instance) current = undefined;
    void instance
      .then((producer) => producer.disconnect())
      .catch((err: unknown) => logger.warn({ err }, 'retired kafka producer did not disconnect cleanly'));
  };

  return {
    async ready() {
      if (closed) throw new PublishError(new Error('publisher closed'), 0, 0);
      try {
        await connected();
      } catch (cause) {
        throw new PublishError(cause, 0, 0);
      }
    },
    async publish(records) {
      if (records.length === 0) return;
      if (closed) throw new PublishError(new Error('publisher closed'), records.length, records.length);
      const instance = connected();
      let producer: KafkaJS.Producer;
      try {
        producer = await instance;
      } catch (cause) {
        throw new PublishError(cause, records.length, records.length);
      }
      const results = await Promise.allSettled(
        records.map((record) =>
          producer.send({
            topic: record.topic,
            messages: [{ key: record.key, value: record.value, headers: { ...record.headers } }],
          }),
        ),
      );
      const failures = results.filter((result) => result.status === 'rejected');
      const [first] = failures;
      if (first === undefined) return;
      if (classifyPublishFailure(first.reason) === 'fatal') retire(instance);
      throw new PublishError(first.reason, failures.length, records.length);
    },
    async close() {
      closed = true;
      const instance = current;
      current = undefined;
      const producer = await instance?.catch(() => undefined);
      await producer?.disconnect();
    },
  };
}
