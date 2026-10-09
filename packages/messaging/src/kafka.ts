import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Logger } from '@flashdrop/config';

const LOG_LEVELS = {
  nothing: KafkaJS.logLevel.NOTHING,
  error: KafkaJS.logLevel.ERROR,
  warn: KafkaJS.logLevel.WARN,
  info: KafkaJS.logLevel.INFO,
  debug: KafkaJS.logLevel.DEBUG,
} as const;

export type KafkaLogLevel = keyof typeof LOG_LEVELS;

export interface KafkaOptions {
  readonly brokers: readonly string[];
  readonly clientId: string;
  readonly logLevel?: KafkaLogLevel;
  /** Where the client's own lines go (librdkafka's and the binding's); its default prints with console.*. */
  readonly logger?: Pick<Logger, 'error' | 'warn' | 'info' | 'debug'>;
}

/** A client for the librdkafka-backed, KafkaJS-compatible API of `@confluentinc/kafka-javascript`. */
export function createKafka({ brokers, clientId, logLevel = 'warn', logger }: KafkaOptions): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: {
      brokers: [...brokers],
      clientId,
      logLevel: LOG_LEVELS[logLevel],
      ...(logger === undefined ? {} : { logger: kafkaLogger(logger) }),
    },
  });
}

/**
 * The client's logger interface over pino, so its lines are JSON with the process's context instead of
 * multi-line `console.warn` objects. The client sets the level from `logLevel` on every producer, consumer
 * and admin it creates and expects the logger to filter; its extra fields (`fac`, `name`, `timestamp`) go
 * under `kafka`.
 */
export function kafkaLogger(log: Pick<Logger, 'error' | 'warn' | 'info' | 'debug'>): KafkaJS.Logger {
  let level: KafkaJS.logLevel = KafkaJS.logLevel.INFO;
  const self: KafkaJS.Logger = {
    error: (message, extra) => {
      if (level >= KafkaJS.logLevel.ERROR) log.error({ kafka: extra }, message);
    },
    warn: (message, extra) => {
      if (level >= KafkaJS.logLevel.WARN) log.warn({ kafka: extra }, message);
    },
    info: (message, extra) => {
      if (level >= KafkaJS.logLevel.INFO) log.info({ kafka: extra }, message);
    },
    debug: (message, extra) => {
      if (level >= KafkaJS.logLevel.DEBUG) log.debug({ kafka: extra }, message);
    },
    namespace: () => self,
    setLogLevel: (next) => {
      level = next;
    },
  };
  return self;
}

/**
 * How long a record may wait for its acknowledgement before its send fails (librdkafka
 * `message.timeout.ms`). The relay's transaction outlives it (`transaction_timeout = 20s`, §5.4), so every
 * send of a batch settles, acked or failed, before Postgres could end the transaction under it.
 */
export const MESSAGE_TIMEOUT_MS = 10_000;

/**
 * The producer every FlashDrop process uses (design §6.1, §5.4): idempotent with `acks=all`, lz4 batches
 * that linger 5 ms, sends that settle within 10 s, and Java's murmur2 partitioner. librdkafka's own default
 * (`consistent_random`, a CRC32 hash) would put a product on a different partition than the JVM clients and
 * tools do (§15), and per-product ordering depends on every producer agreeing. Keys outside `kafkaJS` are
 * raw librdkafka properties and win over the translated ones (M0 spike §2.2).
 */
export function createProducer(kafka: KafkaJS.Kafka): KafkaJS.Producer {
  return kafka.producer({
    kafkaJS: { idempotent: true, acks: -1, compression: KafkaJS.CompressionTypes.LZ4 },
    'linger.ms': 5,
    'message.timeout.ms': MESSAGE_TIMEOUT_MS,
    'socket.timeout.ms': 10_000,
    partitioner: 'murmur2_random',
  } satisfies KafkaJS.ProducerConstructorConfig);
}
