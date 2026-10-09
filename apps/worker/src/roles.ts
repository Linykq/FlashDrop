import type { WorkerRole } from '@flashdrop/config';
import type { ConsumerRunnerOptions, Publisher } from '@flashdrop/messaging';
import { type ConsumerName, startConsumer } from './consumers';
import { closeUnpaidLoop } from './consumers/close-unpaid';
import { createPspClient } from './consumers/psp-client';
import type { WorkerDeps } from './deps';
import type { ComponentHealth } from './health';
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

const IMPLEMENTED = {
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
} as const satisfies Partial<Record<WorkerRole, Starter>>;

type ImplementedRole = keyof typeof IMPLEMENTED;

/** The milestone that brings each remaining role (design §16). */
const PLANNED = {
  dashboard: 'M7',
  listing: 'M8',
} as const satisfies Record<Exclude<WorkerRole, ImplementedRole>, `M${number}`>;

function isImplemented(role: WorkerRole): role is ImplementedRole {
  return role in IMPLEMENTED;
}

/** Thrown at startup when `WORKER_ROLES` enables a role this build does not have yet. */
export class RoleNotImplementedError extends Error {
  override name = 'RoleNotImplementedError';
}

/**
 * Starts every role in `roles`, or none: a role that is not implemented yet fails the start before any
 * role runs, naming the milestone that brings it, rather than running a worker that silently skips work it
 * was asked to do. A role that fails to start (Kafka unreachable, say) stops the ones already started.
 */
export async function startRoles(roles: readonly WorkerRole[], context: RoleContext): Promise<RunningRole[]> {
  const missing = roles.filter((role): role is Exclude<WorkerRole, ImplementedRole> => !isImplemented(role));
  if (missing.length > 0) {
    const list = missing.map((role) => `${role} (until ${PLANNED[role]})`).join(', ');
    throw new RoleNotImplementedError(
      `WORKER_ROLES enables roles that are not implemented yet: ${list}. Remove them from WORKER_ROLES.`,
    );
  }
  const started: RunningRole[] = [];
  try {
    for (const role of roles.filter(isImplemented))
      started.push({ role, ...(await IMPLEMENTED[role](context)) });
  } catch (err) {
    await Promise.allSettled(started.map((role) => role.stop()));
    throw err;
  }
  return started;
}
