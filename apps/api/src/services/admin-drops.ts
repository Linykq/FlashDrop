import type { AdminDrop, AdminDropAction, CreateDropBody, PatchDropBody } from '@flashdrop/contracts';
import {
  type AdminDropRecord,
  applyDropAction,
  constraintOf,
  createDraftDrop,
  type DropSettings,
  getAdminDrop,
  patchDraftDrop,
} from '@flashdrop/db';
import { BugError, DomainError, NotFoundError, ValidationError } from '@flashdrop/domain';
import {
  assertDropLockHeld,
  type DropLockDeps,
  fdSetStatus,
  type HeldDropLock,
  rebuildDrop,
  type SyncDeps,
  type SyncOutcome,
  withDropLock,
} from '@flashdrop/inventory';

/*
 * Drop administration (design §4.7, §5.1). A drop is edited only while DRAFT; `arm` moves it to SCHEDULED and
 * builds its Redis state through `syncDropFromPostgres`, the same path that recovers it, after which it is
 * immutable apart from its status.
 *
 * Every action runs under the per-drop lock, shared with the worker's scheduler and reconciler through
 * Postgres: a status change can never interleave with a rebuild. An admin waits up to 10 s for it and then
 * gets 409 `DROP_BUSY`. Under the lock Postgres changes first (a CAS on the expected status), then Redis:
 * a crash between the two leaves Redis behind, never ahead, and the scheduler's level-triggered repair or
 * the reconciler catches it up.
 */

export interface AdminDropService {
  create(body: CreateDropBody): Promise<AdminDrop>;
  patch(dropId: string, body: PatchDropBody): Promise<AdminDrop>;
  act(dropId: string, action: AdminDropAction): Promise<AdminDrop>;
}

export interface AdminDropDeps extends SyncDeps {
  /** Sessions for the drop lock: a pool built with `DROP_LOCK_POOL_PROFILE`. */
  readonly lock: DropLockDeps;
  /** The wait for a busy drop before 409 `DROP_BUSY`; `DROP_LOCK_TIMEOUT_MS` (10 s) unless a test shortens it. */
  readonly lockTimeoutMs?: number;
}

export function toAdminDrop({ drop, inventory }: AdminDropRecord): AdminDrop {
  return {
    id: drop.id,
    productId: drop.productId,
    roomId: drop.roomId,
    status: drop.status,
    startsAt: drop.startsAt.toISOString(),
    endsAt: drop.endsAt.toISOString(),
    priceCents: drop.priceCents,
    currency: drop.currency,
    perUserLimit: drop.perUserLimit,
    holdSeconds: drop.holdSeconds,
    paymentSeconds: drop.paymentSeconds,
    inventory,
  };
}

/** The DTO's ISO instants as the `Date`s the statements take; absent fields stay absent. */
function settingsOf(body: PatchDropBody): Partial<DropSettings> {
  const { startsAt, endsAt, ...rest } = body;
  return {
    ...rest,
    ...(startsAt === undefined ? {} : { startsAt: new Date(startsAt) }),
    ...(endsAt === undefined ? {} : { endsAt: new Date(endsAt) }),
  };
}

/** Foreign keys of `drops` an admin can miss with a typo: an unknown product or room is a 400, not a 500. */
const REFERENCES: Readonly<Record<string, string>> = {
  drops_product_id_products_id_fk: 'productId',
  drops_room_id_rooms_id_fk: 'roomId',
};

function rethrowReference(error: unknown): never {
  const path = REFERENCES[constraintOf(error) ?? ''];
  if (path === undefined) throw error;
  throw new ValidationError([{ path, message: 'does not exist' }], { cause: error });
}

/** A rebuild's outcome for a drop that the caller knows is armed: anything but a rebuild is a bug. */
function expectRebuilt(dropId: string, outcome: SyncOutcome): void {
  if (outcome.kind === 'UNKNOWN_DROP' || outcome.kind === 'NOT_ARMED') {
    throw new BugError(`drop ${dropId} answered ${outcome.kind} to a rebuild under its lock`);
  }
}

/** Arms a DRAFT drop: DRAFT → SCHEDULED in Postgres, then the full Redis sync, under one hold of the lock. */
async function arm(deps: AdminDropDeps, lock: HeldDropLock): Promise<void> {
  await applyDropAction(deps.db, lock.dropId, 'arm');
  // If the sync fails midway the drop is armed but RECONCILING or missing in Redis: it is tracked now, so
  // the reconciler finishes the job within seconds, and reserves answer 503 RETRY until then.
  expectRebuilt(lock.dropId, await rebuildDrop(deps, lock));
}

/** Pause, resume or end: the Postgres CAS, then `fd_set_status` with the status Postgres landed on. */
async function changeStatus(
  deps: AdminDropDeps,
  lock: HeldDropLock,
  action: 'pause' | 'resume' | 'end',
): Promise<void> {
  const change = await applyDropAction(deps.db, lock.dropId, action);
  if (change.to === 'DRAFT') throw new BugError(`${action} moved drop ${lock.dropId} to DRAFT`);
  assertDropLockHeld(lock);
  const result = await fdSetStatus(deps.redis, lock.dropId, change.to);
  switch (result.kind) {
    case 'OK':
    case 'NOOP':
      return;
    // A dead rebuild left the drop RECONCILING, or its keys are gone: the full sync writes the new status
    // from the snapshot, which already holds the committed change.
    case 'RETRY':
    case 'NO_DROP':
      expectRebuilt(lock.dropId, await rebuildDrop(deps, lock));
      return;
    case 'BAD_STATUS':
      throw new BugError(`fd_set_status refused ${change.to}`);
  }
}

/** Reconcile: the full sync of an armed drop, on demand. */
async function reconcile(deps: AdminDropDeps, lock: HeldDropLock): Promise<void> {
  const outcome = await rebuildDrop(deps, lock);
  if (outcome.kind === 'UNKNOWN_DROP') throw new NotFoundError('Drop');
  if (outcome.kind === 'NOT_ARMED')
    throw new DomainError('CONFLICT', 'A DRAFT drop has no Redis state; arm it');
  // STALE: a newer generation is already in Redis, which is what reconcile asks for.
}

export function createAdminDrops(deps: AdminDropDeps): AdminDropService {
  const lockOptions = deps.lockTimeoutMs === undefined ? {} : { timeoutMs: deps.lockTimeoutMs };

  async function current(dropId: string): Promise<AdminDrop> {
    const record = await getAdminDrop(deps.db, dropId);
    if (record === undefined) throw new NotFoundError('Drop');
    return toAdminDrop(record);
  }

  return {
    async create(body) {
      const { startsAt, endsAt, ...rest } = body;
      const settings = { ...rest, startsAt: new Date(startsAt), endsAt: new Date(endsAt) };
      return toAdminDrop(await createDraftDrop(deps.db, settings).catch(rethrowReference));
    },

    async patch(dropId, body) {
      // The lock is not needed for safety (the row lock orders a PATCH against an arm's CAS), but every
      // drop action takes it (§5.1), so an admin never edits a drop while a sync of it runs.
      return withDropLock(
        deps.lock,
        dropId,
        async () =>
          toAdminDrop(await patchDraftDrop(deps.db, dropId, settingsOf(body)).catch(rethrowReference)),
        lockOptions,
      );
    },

    async act(dropId, action) {
      await withDropLock(
        deps.lock,
        dropId,
        (lock) => {
          switch (action) {
            case 'arm':
              return arm(deps, lock);
            case 'reconcile':
              return reconcile(deps, lock);
            case 'pause':
            case 'resume':
            case 'end':
              return changeStatus(deps, lock, action);
          }
        },
        lockOptions,
      );
      return current(dropId);
    },
  };
}
