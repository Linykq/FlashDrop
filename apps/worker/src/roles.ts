import { closeAll, type WorkerRole } from '@flashdrop/config';
import { BugError } from '@flashdrop/domain';
import type { ConsumerRunnerOptions, Publisher } from '@flashdrop/messaging';
import { type ConsumerName, startConsumer } from './consumers';
import { closeUnpaidLoop } from './consumers/close-unpaid';
import { createPspClient, type PspClientOptions } from './consumers/psp-client';
import type { WorkerDeps } from './deps';
import type { ComponentHealth } from './health';
import { type ListingRoleSettings, startListingRole } from './listing';
import { createLoop } from './loop';
import { startReconciler } from './reconciler';
import { startRelay } from './relay';
import { sweeperLoops } from './sweeper';

/*
 * The role runner (design §2): one worker image, roles selected with `WORKER_ROLES`. Compose runs four
 * services from it: `worker` (relay, sweeper, reconciler: the singleton loops), `listing` (the LLM
 * listing generator, apart so its provider failures never take the loops down), `consumers` (payment and
 * settlement, the money groups) and `dashboard-consumers` (dashboard). `pnpm dev` runs every role in one
 * process.
 */

export interface RoleContext {
  readonly deps: WorkerDeps;
  /** For connections a role opens itself: the reconciler's and the relay's LISTEN, the relay's pool. */
  readonly databaseUrl: string;
  readonly kafka: ConsumerRunnerOptions['kafka'];
  /** The process's one producer: the relay's sends and the consumers' dead letters. */
  readonly publisher: Publisher;
  /** `PAYMENT_MOCK_URL` and `PSP_API_KEY`, for the payment role; absent in a process without the key. */
  readonly psp?: PspClientOptions;
  /** `FD_CHAOS_DUP_DELIVERY`: the relay publishes every batch twice (the `dup-delivery` chaos case). */
  readonly chaosDupDelivery: boolean;
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

/** A group whose handlers never call the PSP. */
const consumer =
  (name: Exclude<ConsumerName, 'payment'>): Starter =>
  async ({ deps, kafka, publisher }) => {
    const runner = await startConsumer(name, deps, { kafka, dlq: publisher });
    return { health: () => [runner.health()], stop: () => runner.stop() };
  };

const STARTERS = {
  relay: async ({ deps, databaseUrl, publisher, chaosDupDelivery }) => {
    const relay = startRelay(deps, { databaseUrl, publisher, duplicateBatches: chaosDupDelivery });
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
    const { deps, kafka, publisher } = context;
    // The environment refuses WORKER_ROLES with payment and no PSP_API_KEY (WorkerPspEnv).
    if (context.psp === undefined) throw new BugError('the payment role started without PSP_API_KEY');
    const psp = createPspClient(context.psp);
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
    await closeAll(
      context.deps.logger,
      Object.fromEntries(started.map((role) => [`role ${role.role}`, () => role.stop()])),
    );
    throw err;
  }
  return started;
}
