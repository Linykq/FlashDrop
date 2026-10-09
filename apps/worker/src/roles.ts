import type { WorkerRole } from '@flashdrop/config';
import type { ConsumerRunnerOptions, Publisher } from '@flashdrop/messaging';
import { type ConsumerName, startConsumer } from './consumers';
import { closeUnpaidLoop } from './consumers/close-unpaid';
import { createPspClient } from './consumers/psp-client';
import type { WorkerDeps } from './deps';
import type { ComponentHealth } from './health';
import { type ListingRoleSettings, startListingRole } from './listing';
import { createLoop } from './loop';
import { startReconciler } from './reconciler';
import { startRelay } from './relay';
import { sweeperLoops } from './sweeper';

/*
 * The role runner (design §2): one worker image, roles selected with `WORKER_ROLES`. Compose runs the
 * singletons (relay, sweeper, reconciler, listing) in `worker` and the consumer groups (payment,
 * settlement, dashboard) in `consumers`.
 */

export interface RoleContext {
  readonly deps: WorkerDeps;
  /** For connections a role opens itself: the reconciler's and the relay's LISTEN, the relay's pool. */
  readonly databaseUrl: string;
  readonly kafka: ConsumerRunnerOptions['kafka'];
  /** The process's one producer: the relay's sends and the consumers' dead letters. */
  readonly publisher: Publisher;
  /** `PAYMENT_MOCK_URL`, for the payment consumer. */
  readonly paymentMockUrl: string;
  /** `LlmEnv` and the fixtures directory, for the listing role. */
  readonly listing: ListingRoleSettings;
}

export interface RunningRole {
  readonly role: WorkerRole;
  /** One entry per loop, relay or consumer group (`GET /health`). */
  health(): readonly ComponentHealth[];
  stop(): Promise<void>;
}

type Starter = (context: RoleContext) => Promise<Omit<RunningRole, 'role'>>;

const consumer =
  (name: ConsumerName): Starter =>
  async ({ deps, kafka, publisher, paymentMockUrl }) => {
    const psp = createPspClient({ baseUrl: paymentMockUrl });
    const runner = await startConsumer(name, { ...deps, psp }, { kafka, dlq: publisher });
    return { health: () => [runner.health()], stop: () => runner.stop() };
  };

const STARTERS = {
  relay: async ({ deps, databaseUrl, publisher }) => {
    const relay = startRelay(deps, { databaseUrl, publisher });
    return { health: () => [relay.health()], stop: () => relay.stop() };
  },
  sweeper: async ({ deps }) => {
    const logger = deps.logger.child({ role: 'sweeper' });
    const loops = sweeperLoops({ ...deps, logger }).map((spec) => createLoop(spec, logger));
    for (const loop of loops) loop.start();
    return {
      health: () => loops.map((loop) => loop.health()),
      async stop() {
        await Promise.all(loops.map((loop) => loop.stop()));
      },
    };
  },
  reconciler: async ({ deps, databaseUrl }) => {
    const reconciler = startReconciler(deps, { databaseUrl });
    return { health: () => reconciler.loops.map((loop) => loop.health()), stop: () => reconciler.stop() };
  },
  // The payment group, and beside it the close-unpaid loop, which needs the same PSP client (§6.5).
  payment: async (context) => {
    const { deps, kafka, publisher, paymentMockUrl } = context;
    const psp = createPspClient({ baseUrl: paymentMockUrl });
    const runner = await startConsumer('payment', { ...deps, psp }, { kafka, dlq: publisher });
    const logger = deps.logger.child({ role: 'payment' });
    const loop = createLoop(closeUnpaidLoop({ db: deps.db, psp, logger }), logger);
    loop.start();
    return {
      health: () => [runner.health(), loop.health()],
      async stop() {
        await Promise.all([loop.stop(), runner.stop()]);
      },
    };
  },
  settlement: consumer('settlement'),
  dashboard: consumer('dashboard'),
  listing: ({ deps, listing }) => startListingRole(deps, listing),
} as const satisfies Record<WorkerRole, Starter>;

/**
 * Starts every role in `roles`, in order. A role that fails to start (Kafka unreachable, say) stops the
 * ones already started.
 */
export async function startRoles(roles: readonly WorkerRole[], context: RoleContext): Promise<RunningRole[]> {
  const started: RunningRole[] = [];
  try {
    for (const role of roles) started.push({ role, ...(await STARTERS[role](context)) });
  } catch (err) {
    await Promise.allSettled(started.map((role) => role.stop()));
    throw err;
  }
  return started;
}
