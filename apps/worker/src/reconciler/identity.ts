import type { Db } from '@flashdrop/db';
import {
  commitRedisIdentity,
  type FlashdropRedis,
  type LiveRedisIdentity,
  readLiveRedisIdentity,
  readStoredRedisIdentity,
  type StoredRedisIdentity,
} from '@flashdrop/inventory';

/**
 * Where the reconciler reads and records which Redis it last rebuilt (design §4.7): `fd:epoch` plus INFO
 * `run_id` and the library, against `system_state`. An interface, so integration tests can give the
 * reconciler an epoch of their own instead of the one the whole development stack shares.
 */
export interface RedisIdentityStore {
  readLive(): Promise<LiveRedisIdentity>;
  readStored(): Promise<StoredRedisIdentity>;
  /** Records a completed full rebuild; `runId` is the one read before the rebuild started. */
  commit(runId: string): Promise<void>;
}

export function redisIdentityStore(deps: {
  readonly redis: FlashdropRedis;
  readonly db: Db;
}): RedisIdentityStore {
  return {
    readLive: () => readLiveRedisIdentity(deps.redis),
    readStored: () => readStoredRedisIdentity(deps.db),
    commit: async (runId) => {
      await commitRedisIdentity(deps, runId);
    },
  };
}
