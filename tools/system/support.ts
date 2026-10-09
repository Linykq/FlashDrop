import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { KafkaEnv, loadEnv, ORDERS_PARTITIONS, PostgresEnv, RedisEnv, TOPICS } from '@flashdrop/config';
import {
  type CheckoutBody,
  OrderDetailResponse,
  OrderEvent,
  OrderResponse,
  type PaymentMethod,
  StockSnapshot,
  TEST_SECRET_HEADER,
  type TestDropBody,
  TestDropResponse,
  TestSessionsResponse,
} from '@flashdrop/contracts';
import { createDb, createPool, type Db } from '@flashdrop/db';
import { createCommandClient, type FlashdropRedis } from '@flashdrop/inventory';
import {
  createGroupLagReader,
  createKafka,
  createProducer,
  DLQ_HEADERS,
  type GroupLagReader,
  headersAsText,
  partitionForKey,
} from '@flashdrop/messaging';
import { z } from 'zod';
import { stackSecret } from '../env-file';
import { createEventsProbe, SAMPLE_TIMEOUT_MS } from '../event-samples';
import { type InvariantsReport, verifyInvariants } from '../invariant-samples';

/*
 * System tests (design §13, §16 M3/M4 demos): the running Compose stack, driven like an operator would,
 * through Caddy, `docker compose` and read-only looks at Postgres, Redis, Kafka and the PSP ledger. Each test
 * makes its own drop through the test routes, so it never depends on, or disturbs, another's stock. They stop
 * and start shared services (Kafka, payment-mock, the worker, the consumers), so the files run one at a time
 * (vitest project `system`) and every test puts back what it stopped, also when it fails.
 *
 *   ENABLE_TEST_ROUTES=true pnpm stack:up && FD_SYSTEM_TESTS=1 pnpm test:system
 *
 * The stack's Kafka is the one every integration test on the machine uses, and pausing or stopping it for up
 * to a minute fails their runs. So `compose`, the only way to a service here, refuses unless
 * FD_SYSTEM_TESTS=1 says this run may disrupt the stack: a bare `vitest run` never does. CI gives the tests
 * a stack of their own (the system job); on a shared machine, so does compose.isolated.yaml, a second
 * project on other host ports (its header has the commands).
 *
 * Nothing here reads the environment on import: the stack's address, secret and stores are read when first
 * used, so the chaos run (tests/chaos/run.ts) imports this like any module and points the process at its
 * target before calling anything.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const exec = promisify(execFile);

/**
 * `docker compose --profile app <args>` from the repo root, with this process's environment, so CI's
 * `COMPOSE_FILE=compose.yaml:compose.ci.yaml` applies, and `overrides` for the services it (re)creates.
 * Resolves with its standard output.
 */
export async function compose(
  args: readonly string[],
  overrides: Record<string, string> = {},
): Promise<string> {
  if (process.env.FD_SYSTEM_TESTS !== '1') {
    throw new Error(
      'the system tests stop, kill and re-create services of the running stack, and pause its Kafka: ' +
        'run them only on a stack nobody else is using, with FD_SYSTEM_TESTS=1',
    );
  }
  const { stdout } = await exec('docker', ['compose', '--profile', 'app', ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...overrides },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Starts stopped services again, the same containers, and waits until they report healthy. Never
 * re-creates one: a container made from a newer image or another interpolation of compose.yaml would not be
 * the stack under test.
 */
export async function startServices(...services: string[]): Promise<void> {
  await compose([
    'up',
    '--detach',
    '--wait',
    '--wait-timeout',
    '180',
    '--no-deps',
    '--no-recreate',
    ...services,
  ]);
}

/** A graceful stop: SIGTERM, then Compose's grace period. */
export async function stopServices(...services: string[]): Promise<void> {
  await compose(['stop', ...services]);
}

/** SIGKILL, the way a crash ends a process: no shutdown hook runs. */
export async function killService(service: string): Promise<void> {
  await compose(['kill', '--signal', 'SIGKILL', service]);
}

/**
 * Every charge succeeds and its answer is withheld until the payment consumer's 5 s timeout gives up on it
 * (timeout-after-success, §6.5). At info, payment-mock logs each withheld answer, which the tests count.
 */
export const WITHHOLD_EVERY_ANSWER = {
  PSP_TIMEOUT_AFTER_SUCCESS_RATE: '1',
  PSP_ERROR_RATE: '0',
  LOG_LEVEL: 'info',
} as const;

/**
 * Re-creates payment-mock with `overrides` of its PSP_* settings (and LOG_LEVEL), which compose.yaml
 * interpolates; with none it gets the stack's own settings back.
 */
export async function recreatePaymentMock(overrides: Record<string, string> = {}): Promise<void> {
  await compose(
    ['up', '--detach', '--wait', '--wait-timeout', '180', '--no-deps', '--force-recreate', 'payment-mock'],
    overrides,
  );
}

/**
 * When each container of a service last started, by container id: unchanged across a test means none of them
 * crashed or was restarted meanwhile.
 */
export async function containerStarts(service: string): Promise<Record<string, string>> {
  const ids = (await compose(['ps', '--all', '--quiet', service])).split(/\s+/).filter(Boolean);
  if (ids.length === 0) throw new Error(`no container for ${service}`);
  const { stdout } = await exec('docker', [
    'inspect',
    '--format',
    '{{.Id}} {{.State.Running}} {{.State.StartedAt}}',
    ...ids,
  ]);
  return Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [id = '', running, startedAt = ''] = line.split(' ');
        return [id.slice(0, 12), running === 'true' ? startedAt : 'not running'];
      }),
  );
}

/** A service's log since its container was created. */
export function serviceLogs(service: string): Promise<string> {
  return compose(['logs', '--no-color', service]);
}

// ---------------------------------------------------------------- the stores, read-only

type Pool = ReturnType<typeof createPool>;

export interface Stores {
  readonly db: Db;
  /** For the evidence queries below, which read rows as `pg` returns them. */
  readonly pool: Pool;
  readonly redis: FlashdropRedis;
  readonly kafka: KafkaJS.Kafka;
  readonly admin: KafkaJS.Admin;
  /** Consumer groups' committed lag on `orders.v1` (lag.ts: never the admin API's group offsets request). */
  readonly lag: GroupLagReader;
  close(): Promise<void>;
}

export interface StoresOptions {
  /**
   * Where the Redis client reports its errors (default `console`). The chaos runs (tests/chaos) restart
   * Redis on purpose and pass a quieter one than a stack trace per reconnect attempt.
   */
  readonly redisLogger?: Pick<Console, 'warn'>;
}

/**
 * Postgres, the stack's Redis (a plain client: it never loads the Functions library), a Kafka admin and a
 * lag reader.
 */
export async function connectStores({ redisLogger = console }: StoresOptions = {}): Promise<Stores> {
  const env = loadEnv([PostgresEnv, RedisEnv, KafkaEnv]);
  const pool = createPool({
    connectionString: env.DATABASE_URL,
    logger: { warn: () => undefined },
    settings: { statement_timeout: '30s' },
    connectionTimeoutMillis: 10_000,
    applicationName: 'system-tests',
    max: 4,
  });
  const redis = createCommandClient({ url: env.REDIS_URL, name: 'system-tests', logger: redisLogger });
  await redis.connect();
  const kafka = createKafka({ brokers: env.KAFKA_BROKERS, clientId: 'system-tests', logLevel: 'error' });
  const admin = kafka.admin();
  await admin.connect();
  const lag = createGroupLagReader(kafka, { timeoutMs: SAMPLE_TIMEOUT_MS });
  return {
    db: createDb(pool),
    pool,
    redis,
    kafka,
    admin,
    lag,
    async close() {
      redis.destroy();
      await admin.disconnect().catch(() => undefined);
      await lag.close();
      await pool.end();
    },
  };
}

/** `verify:invariants` v2 for these drops, the event pipeline included (INV-5), as CI runs it. */
export function verifyDrops(
  stores: Stores,
  dropIds: readonly string[],
  timeoutMs = 90_000,
): Promise<InvariantsReport> {
  return verifyInvariants(
    {
      db: stores.db,
      redis: stores.redis,
      events: createEventsProbe({ db: stores.db, admin: stores.admin, lag: stores.lag }),
    },
    { dropIds, timeoutMs },
  );
}

/** The failed invariants and quiescence checks of a report, for a readable assertion. */
export function problemsIn(report: InvariantsReport): string[] {
  return [
    ...report.quiescence.checks.filter((c) => c.status === 'fail').map((c) => `${c.name}: ${c.detail ?? ''}`),
    ...report.invariants
      .filter((result) => result.status === 'fail')
      .map((result) => `${result.id}: ${JSON.stringify(result.violations.slice(0, 3))}`),
  ];
}

/** Polls `read` until `done` accepts its value; returns it. */
export async function until<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`${what}: still ${JSON.stringify(value)} after ${timeoutMs} ms`);
    await sleep(250);
  }
}

// ---------------------------------------------------------------- the api, through Caddy

interface Call {
  readonly token?: string;
  readonly key?: string;
  readonly body?: unknown;
  readonly test?: boolean;
}

/** The stack's edge, as browsers and the E2E specs reach it. */
const baseUrl = (): string => new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:8080').origin;

async function call(method: string, path: string, { token, key, body, test }: Call = {}) {
  const origin = baseUrl();
  const headers: Record<string, string> = { origin };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== undefined) headers.cookie = `fd_session=${token}`;
  if (key !== undefined) headers['idempotency-key'] = key;
  // The api's own value: the shell's, else the one `pnpm stack:up` wrote to .env (Vitest loads .env too).
  if (test === true) headers[TEST_SECRET_HEADER] = stackSecret('TEST_ROUTES_SECRET');
  const response = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return { status: response.status, json: text === '' ? undefined : (JSON.parse(text) as unknown) };
}

async function expectStatus(what: string, status: number, response: Awaited<ReturnType<typeof call>>) {
  if (response.status !== status) {
    throw new Error(`${what}: expected ${status}, got ${response.status} ${JSON.stringify(response.json)}`);
  }
  return response.json;
}

export type TestDrop = z.output<typeof TestDropResponse>;

/** `POST /test/drops` through the edge: a fresh product and drop, armed and open from now. */
export async function postTestDrop(body: Partial<z.input<typeof TestDropBody>>): Promise<TestDrop> {
  const settings = { stock: 10, perUserLimit: 2, holdSeconds: 120, paymentSeconds: 300, ...body };
  const json = await expectStatus(
    'test drop',
    201,
    await call('POST', '/test/drops', { body: settings, test: true }),
  );
  return TestDropResponse.parse(json);
}

export interface Buyer {
  readonly userId: string;
  readonly token: string;
}

export async function createBuyers(count: number): Promise<Buyer[]> {
  const json = await expectStatus(
    'test sessions',
    200,
    await call('POST', '/test/sessions', { body: { count }, test: true }),
  );
  return TestSessionsResponse.parse(json).sessions;
}

/** `POST /drops/:dropId/reservations` for one unit; returns the order id. */
export async function reserve(buyer: Buyer, dropId: string): Promise<string> {
  const response = await call('POST', `/drops/${dropId}/reservations`, {
    token: buyer.token,
    key: `sys_${randomUUID()}`,
    body: { qty: 1 },
  });
  return OrderResponse.parse(await expectStatus('reserve', 201, response)).order.id;
}

export const SHIPPING = {
  name: 'Ada Lovelace',
  line1: '1 Market Street',
  city: 'San Francisco',
  state: 'CA',
  postalCode: '94105',
  country: 'US',
} as const satisfies CheckoutBody['shipping'];

/** `POST /orders/:orderId/checkout` under a fresh key; returns the HTTP status (202 for a new submit). */
export async function checkout(buyer: Buyer, orderId: string, paymentMethod: PaymentMethod = 'pm_ok') {
  const body: CheckoutBody = { shipping: SHIPPING, paymentMethod };
  return (
    await call('POST', `/orders/${orderId}/checkout`, {
      token: buyer.token,
      key: `sys_${randomUUID()}`,
      body,
    })
  ).status;
}

/** A purchase load in progress: each buyer reserves one unit and checks it out. */
export interface PurchaseLoad {
  /** Orders checked out so far (202). */
  placed(): number;
  /** No buyer starts after this; those under way finish. */
  stop(): void;
  /** The order ids, once every buyer is through or stopped; rejects on the first unexpected answer. */
  readonly finished: Promise<string[]>;
}

/** `paceMs` spaces each lane's purchases, so a load of a given size lasts long enough to act during it. */
export function purchaseAll(
  buyers: readonly Buyer[],
  dropId: string,
  {
    concurrency,
    paceMs = 0,
    paymentMethod = 'pm_ok',
  }: { concurrency: number; paceMs?: number; paymentMethod?: PaymentMethod },
): PurchaseLoad {
  const queue = [...buyers];
  const orders: string[] = [];
  let stopped = false;
  async function lane(): Promise<void> {
    for (let buyer = queue.shift(); buyer !== undefined && !stopped; buyer = queue.shift()) {
      const orderId = await reserve(buyer, dropId);
      const status = await checkout(buyer, orderId, paymentMethod);
      if (status !== 202) throw new Error(`checkout of ${orderId}: expected 202, got ${status}`);
      orders.push(orderId);
      if (paceMs > 0) await sleep(paceMs);
    }
  }
  const finished = Promise.all(Array.from({ length: concurrency }, lane)).then(() => orders);
  // The test awaits `finished` later; until then this keeps a failure from counting as unhandled.
  finished.catch(() => undefined);
  return {
    placed: () => orders.length,
    stop: () => {
      stopped = true;
    },
    finished,
  };
}

export async function cancel(buyer: Buyer, orderId: string): Promise<number> {
  return (await call('POST', `/orders/${orderId}/cancel`, { token: buyer.token })).status;
}

export async function orderOf(buyer: Buyer, orderId: string) {
  const json = await expectStatus(
    'order',
    200,
    await call('GET', `/orders/${orderId}`, { token: buyer.token }),
  );
  return OrderDetailResponse.parse(json).order;
}

export async function stockOf(dropId: string) {
  return StockSnapshot.parse(await expectStatus('stock', 200, await call('GET', `/drops/${dropId}/stock`)));
}

// ---------------------------------------------------------------- Postgres evidence

const PspCharge = z.object({
  id: z.string(),
  reference: z.string(),
  amount_cents: z.int(),
  status: z.string(),
});

/** The PSP ledger's charges for these references (order ids), oldest first. */
export async function pspCharges(pool: Pool, orderIds: readonly string[]) {
  const { rows } = await pool.query(
    `SELECT id, reference, amount_cents, status FROM psp.charges WHERE reference = ANY($1::text[]) ORDER BY created_at, id`,
    [orderIds],
  );
  return z.array(PspCharge).parse(rows);
}

const PaymentRow = z.object({ order_id: z.string(), status: z.string(), amount_cents: z.int() });

export async function paymentRows(pool: Pool, orderIds: readonly string[]) {
  const { rows } = await pool.query(
    `SELECT order_id::text, status, amount_cents FROM payments WHERE order_id = ANY($1::uuid[])`,
    [orderIds],
  );
  return z.array(PaymentRow).parse(rows);
}

const OutboxRow = z.object({ event_id: z.string(), event_type: z.string(), published: z.boolean() });

/** The outbox rows of these orders: what INV-5 says must reach Kafka. */
export async function outboxOf(pool: Pool, orderIds: readonly string[]) {
  const { rows } = await pool.query(
    `SELECT event_id::text, event_type, published_at IS NOT NULL AS published FROM outbox
     WHERE payload->>'orderId' = ANY($1::text[]) ORDER BY id`,
    [orderIds],
  );
  return z.array(OutboxRow).parse(rows);
}

/** Orders of these ids whose terminal outcome Redis has applied (`redis_settled_at`, §4.6). */
export async function settledInRedis(pool: Pool, orderIds: readonly string[]): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM orders WHERE id = ANY($1::uuid[]) AND redis_settled_at IS NOT NULL`,
    [orderIds],
  );
  return z.array(z.object({ n: z.int() })).parse(rows)[0]?.n ?? 0;
}

/**
 * The outbox right now: unpublished rows, and how many of them a relay batch holds (§5.4: it locks its rows
 * `FOR UPDATE` until the broker acknowledged them and it marked them published). Counted inside a
 * transaction that is rolled back, so the `SKIP LOCKED` probe holds nothing past the call.
 */
export async function outboxInFlight(pool: Pool): Promise<{ pending: number; locked: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT (SELECT count(*)::int FROM outbox WHERE published_at IS NULL) AS pending,
             (SELECT count(*)::int FROM (SELECT 1 FROM outbox WHERE published_at IS NULL
                                         FOR UPDATE SKIP LOCKED) free) AS free`);
    const [counts] = z.array(z.object({ pending: z.int(), free: z.int() })).parse(rows);
    if (counts === undefined) throw new Error('the outbox count returned no row');
    return { pending: counts.pending, locked: counts.pending - counts.free };
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// ---------------------------------------------------------------- Kafka evidence

/** A group's committed lag on one `orders.v1` partition: events it has not processed. */
export async function groupLagOn(stores: Stores, groupId: string, partition: number): Promise<number> {
  const lags = await stores.lag.read(groupId, TOPICS.orders);
  return lags.find((lag) => lag.partition === partition)?.lag ?? 0;
}

/** The `orders.v1` partition a product's events land on (§6.1). */
export const partitionOf = (productId: string) => partitionForKey(productId, ORDERS_PARTITIONS);

/** The log end of every `orders.v1` partition now, to read only what a test adds after it. */
export async function logEnds(admin: KafkaJS.Admin): Promise<Map<number, string>> {
  const offsets = await admin.fetchTopicOffsets(TOPICS.orders);
  return new Map(offsets.map((o) => [o.partition, o.high]));
}

export interface ReadRecord {
  readonly partition: number;
  readonly offset: string;
  readonly key: string | null;
  readonly headers: Readonly<Record<string, string>>;
  /** The value as the relay wrote it, byte for byte (UTF-8 JSON). */
  readonly value: string;
  readonly event: OrderEvent;
}

/**
 * Every `orders.v1` record of one partition from `from` up to its log end now, each value validated as an
 * `OrderEvent`. Read by a throwaway group that never commits and seeks straight to `from`.
 */
export async function readPartition(stores: Stores, partition: number, from: string): Promise<ReadRecord[]> {
  const end = (await logEnds(stores.admin)).get(partition);
  if (end === undefined || BigInt(end) <= BigInt(from)) return [];
  const records: ReadRecord[] = [];
  const consumer = stores.kafka.consumer({
    kafkaJS: { groupId: `fdsys.reader.${randomUUID()}`, fromBeginning: false, autoCommit: false },
  });
  const done = Promise.withResolvers<void>();
  const timer = setTimeout(() => done.reject(new Error(`could not read partition ${partition}`)), 60_000);
  await consumer.connect();
  try {
    await consumer.subscribe({ topics: [TOPICS.orders] });
    // Applied when the partition is assigned; the other partitions start at their end and stay silent.
    consumer.seek({ topic: TOPICS.orders, partition, offset: from });
    await consumer.run({
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, resolveOffset }) => {
        if (batch.partition !== partition) return;
        for (const message of batch.messages) {
          if (BigInt(message.offset) >= BigInt(end)) break;
          const value = message.value?.toString('utf8') ?? 'null';
          records.push({
            partition: batch.partition,
            offset: message.offset,
            key: message.key?.toString('utf8') ?? null,
            headers: headersAsText(message.headers),
            value,
            event: OrderEvent.parse(JSON.parse(value)),
          });
          resolveOffset(message.offset);
          if (BigInt(message.offset) + 1n === BigInt(end)) done.resolve();
        }
      },
    });
    await done.promise;
  } finally {
    clearTimeout(timer);
    await consumer.disconnect();
  }
  return records;
}

// ---------------------------------------------------------------- the DLQ (§6.4)

/**
 * Dead-letters `record` for `consumer` exactly as the runner does after giving up on it: the same key,
 * value and headers, plus the DLQ headers that name the consumer `dlq:replay` will run. Resolves with the
 * letter's offset in `orders.v1.dlq` (one partition).
 */
export async function deadLetter(stores: Stores, record: ReadRecord, consumer: string): Promise<string> {
  const producer = createProducer(stores.kafka);
  await producer.connect();
  try {
    const [delivered] = await producer.send({
      topic: TOPICS.ordersDlq,
      messages: [
        {
          key: record.key,
          value: record.value,
          headers: {
            ...record.headers,
            [DLQ_HEADERS.consumer]: consumer,
            [DLQ_HEADERS.error]: 'dead-lettered by a system test',
            [DLQ_HEADERS.attempts]: '1',
            [DLQ_HEADERS.origPartition]: String(record.partition),
            [DLQ_HEADERS.origOffset]: record.offset,
          },
        },
      ],
    });
    // One record per send, so the batch's base offset is the letter's own.
    if (delivered?.baseOffset == null) throw new Error('the DLQ write reported no offset');
    return delivered.baseOffset;
  } finally {
    await producer.disconnect();
  }
}

/** One line of a service's pino log (`createLogger` of @flashdrop/config writes ISO times). */
const LogLine = z.looseObject({ time: z.string(), msg: z.string() });
export type LogLine = z.output<typeof LogLine>;

/**
 * The pino lines of a service's output, for the system tests and the chaos runs alike; anything else in it (a
 * Node warning, a crash dump, a line cut off when its container was killed mid-write) is not one.
 */
export function logLines(output: string): LogLine[] {
  return output.split('\n').flatMap((line) => {
    const parsed = LogLine.safeParse(jsonOrUndefined(line));
    return parsed.success ? [parsed.data] : [];
  });
}

function jsonOrUndefined(line: string): unknown {
  if (!line.startsWith('{')) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * `dlq:replay` against the stack (§6.4), the way an operator runs it: a one-off of the consumers service,
 * whose image bundles the CLI and whose environment reaches payment-mock, Postgres, Redis and Kafka inside
 * the Compose network. Resolves with its log lines; rejects, with them, when it exits non-zero (a letter
 * that failed again).
 */
export async function replayDeadLetters(args: readonly string[]): Promise<LogLine[]> {
  const command = ['run', '--rm', '--no-deps', '-T', 'consumers', 'node', 'apps/worker/dist/dlq-replay.js'];
  try {
    return logLines(await compose([...command, ...args]));
  } catch (error) {
    const output = error instanceof Error && 'stdout' in error ? String(error.stdout) : '';
    throw new Error(`dlq:replay ${args.join(' ')} failed:\n${output}`, { cause: error });
  }
}
