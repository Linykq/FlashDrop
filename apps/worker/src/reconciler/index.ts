import { SYNC_CHANNEL } from '@flashdrop/inventory';
import type { WorkerDeps } from '../deps';
import { createLeaderLease } from '../leader';
import { listen } from '../listen';
import { createLoop, type Loop } from '../loop';
import { type RedisIdentityStore, redisIdentityStore } from './identity';
import { createReconciler, type ReconcilerTiming } from './reconcile';

export interface ReconcilerOptions extends ReconcilerTiming {
  /** For the dedicated `LISTEN fd_sync` connection. */
  readonly databaseUrl: string;
  /** Defaults to the real `fd:epoch` and `system_state`. */
  readonly identity?: RedisIdentityStore;
  readonly everyMs?: number;
}

export interface ReconcilerRole {
  readonly loops: readonly Loop[];
  stop(): Promise<void>;
}

/**
 * The `reconciler` role (design §4.7): one leader runs the checks every 2 s, and at once when a `NOTIFY
 * fd_sync` arrives (the API saw NO_DROP for a tracked drop or refused a Redis admission in Postgres, or
 * settlement saw NO_DROP). Nudges coalesce: one that arrives during a tick buys exactly one more tick.
 * Standbys keep asking for leadership on every tick.
 */
export function startReconciler(deps: WorkerDeps, options: ReconcilerOptions): ReconcilerRole {
  const logger = deps.logger.child({ role: 'reconciler' });
  const roleDeps = { ...deps, logger };
  const lease = createLeaderLease({ pool: deps.lock.pool, logger }, 'reconciler');
  const reconciler = createReconciler(
    roleDeps,
    options.identity ?? redisIdentityStore({ redis: deps.redis, db: deps.db }),
    options,
  );
  let leading = false;
  const loop = createLoop(
    {
      name: 'reconciler',
      everyMs: options.everyMs ?? 2_000,
      tick: async (signal) => {
        leading = await lease.check();
        if (leading) await reconciler.tick(signal);
      },
    },
    logger,
  );
  const listener = listen({
    connectionString: options.databaseUrl,
    channel: SYNC_CHANNEL,
    applicationName: 'worker:reconciler:listen',
    logger,
    onNotify: (payload) => {
      // Only the leader keeps nudges for its refusal check. A standby that takes over has not seen the
      // earlier ones; the periodic drift check covers whatever they were about.
      if (leading) reconciler.nudged(payload);
      loop.wake();
    },
    // Nudges sent while the connection was down are lost: check everything once it is back.
    onListen: () => loop.wake(),
  });
  loop.start();
  return {
    loops: [loop],
    async stop() {
      await listener.close();
      await loop.stop();
      await lease.release();
    },
  };
}
