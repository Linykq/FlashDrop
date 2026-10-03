import type { WorkerRole } from '@flashdrop/config';
import type { WorkerDeps } from './deps';
import { createLoop, type Loop } from './loop';
import { startReconciler } from './reconciler';
import { sweeperLoops } from './sweeper';

/*
 * The role runner (design §2): one worker image, roles selected with `WORKER_ROLES`. Compose runs the
 * singletons (relay, sweeper, reconciler, listing) in `worker` and the consumer groups (payment,
 * settlement, dashboard) in `consumers`.
 */

export interface RoleContext {
  readonly deps: WorkerDeps;
  /** For connections a role opens itself, such as the reconciler's LISTEN. */
  readonly databaseUrl: string;
}

export interface RunningRole {
  readonly role: WorkerRole;
  readonly loops: readonly Loop[];
  stop(): Promise<void>;
}

type Starter = (context: RoleContext) => Omit<RunningRole, 'role'>;

const IMPLEMENTED = {
  sweeper: ({ deps }) => {
    const logger = deps.logger.child({ role: 'sweeper' });
    const loops = sweeperLoops({ ...deps, logger }).map((spec) => createLoop(spec, logger));
    for (const loop of loops) loop.start();
    return {
      loops,
      async stop() {
        await Promise.all(loops.map((loop) => loop.stop()));
      },
    };
  },
  reconciler: ({ deps, databaseUrl }) => startReconciler(deps, { databaseUrl }),
} as const satisfies Partial<Record<WorkerRole, Starter>>;

type ImplementedRole = keyof typeof IMPLEMENTED;

/** The milestone that brings each remaining role (design §16). */
const PLANNED = {
  relay: 'M3',
  settlement: 'M3',
  payment: 'M4',
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
 * Starts every role in `roles`, or none: a role that is not implemented yet fails the start, naming the
 * milestone that brings it, rather than running a worker that silently skips work it was asked to do.
 */
export function startRoles(roles: readonly WorkerRole[], context: RoleContext): RunningRole[] {
  const missing = roles.filter((role): role is Exclude<WorkerRole, ImplementedRole> => !isImplemented(role));
  if (missing.length > 0) {
    const list = missing.map((role) => `${role} (until ${PLANNED[role]})`).join(', ');
    throw new RoleNotImplementedError(
      `WORKER_ROLES enables roles that are not implemented yet: ${list}. Remove them from WORKER_ROLES.`,
    );
  }
  return roles.filter(isImplemented).map((role) => ({ role, ...IMPLEMENTED[role](context) }));
}
