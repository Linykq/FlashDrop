import type { Logger } from '@flashdrop/config';
import type { Db } from '@flashdrop/db';
import type { DropLockDeps, FlashdropRedis, SyncNudger } from '@flashdrop/inventory';

/** What the worker's roles share: one of each per process (design §2). */
export interface WorkerDeps {
  /** The worker pool (`WORKER_POOL_PROFILE`). */
  readonly db: Db;
  /** The command client, library loaded, no offline queue. */
  readonly redis: FlashdropRedis;
  /** Drop-lock sessions, from a pool with `DROP_LOCK_POOL_PROFILE` (§4.7). */
  readonly lock: DropLockDeps;
  /** `NOTIFY fd_sync`, for `settleRedis` and the scheduler when Redis has lost a drop. */
  readonly nudger: SyncNudger;
  readonly logger: Logger;
}
