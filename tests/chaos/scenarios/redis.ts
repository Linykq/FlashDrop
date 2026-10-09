import {
  type RedisStock,
  redisGeneration,
  redisIdentity,
  redisStock,
} from '../../../tools/system/chaos-support';
import { startServices, until } from '../../../tools/system/support';
import type { BurstResult } from '../burst';
import { containersOf, type LogLine, logsSince } from '../docker';
import type { ChaosContext } from '../harness';

/*
 * What both Redis faults share (design §4.7, §17 "Redis restart losing ≤ 1 s of AOF"): while Redis is down,
 * reserves fail closed with 503 and the burst resends them; checkout and payments go on, since they need
 * only Postgres. Redis comes back with a new `run_id`, so the reconciler (every 2 s) takes every tracked
 * drop to RECONCILING, fences its generation and rebuilds it from Postgres, then records the new `run_id`.
 */

export interface RedisBefore {
  readonly runId: string;
  readonly gen: number;
}

export async function redisBefore(ctx: ChaosContext): Promise<RedisBefore> {
  const [identity, gen] = await Promise.all([
    redisIdentity(ctx.stores),
    redisGeneration(ctx.stores, ctx.drop.dropId),
  ]);
  return { runId: identity.live, gen };
}

/** The drop's Redis stock as soon as the evidence client has reconnected. */
function stockOnReturn(ctx: ChaosContext) {
  return until(
    'the evidence client reconnected to Redis',
    () => redisStock(ctx.stores, ctx.drop.dropId).catch(() => undefined),
    (stock) => stock !== undefined,
    30_000,
  );
}

interface RecoveryLog {
  readonly detected: LogLine | undefined;
  readonly rebuilt: LogLine | undefined;
  readonly dropsRebuilt: number;
}

/** The reconciler's own account of the recovery, from the worker's log since the kill. */
async function recoveryLog(killedAt: number): Promise<RecoveryLog> {
  const [worker] = await containersOf('worker');
  if (worker === undefined) throw new Error('no worker container');
  const lines = await logsSince(worker.id, new Date(killedAt));
  return {
    detected: lines.find((line) => line.msg === 'redis keyspace loss; rebuilding every tracked drop'),
    rebuilt: lines.find((line) => line.msg === 'redis rebuilt from postgres'),
    dropsRebuilt: lines.filter((line) => line.msg === 'drop rebuilt in redis').length,
  };
}

/**
 * Starts the killed Redis (the same container, the same volume) and waits until the reconciler has rebuilt
 * every tracked drop for the new `run_id`. Records the timings, from Redis's start and the reconciler's log
 * lines (one clock, the Docker VM's); resolves with the drop's stock as the evidence client first read it.
 */
export async function startRedisAndAwaitRebuild(
  ctx: ChaosContext,
  before: RedisBefore,
  killedAt: number,
): Promise<RedisStock | null> {
  await startServices('redis');
  const onReturn = await stockOnReturn(ctx);
  const identity = await until(
    'the reconciler rebuilt every tracked drop for the new run_id',
    () => redisIdentity(ctx.stores).catch(() => null),
    (now) => now !== null && now.live !== before.runId && now.recorded === now.live,
    90_000,
  );
  const [redis] = await containersOf('redis');
  const log = await recoveryLog(killedAt);
  const startedAt = Date.parse(redis?.startedAt ?? '');
  const at = (line: LogLine | undefined) => (line === undefined ? Number.NaN : Date.parse(line.time));
  const timings = {
    downMs: startedAt - Date.parse(redis?.finishedAt ?? ''),
    detectedAfterStartMs: at(log.detected) - startedAt,
    rebuildMs: at(log.rebuilt) - at(log.detected),
  };
  const gen = await redisGeneration(ctx.stores, ctx.drop.dropId);
  ctx.log(
    `Redis down ${(timings.downMs / 1000).toFixed(1)} s; the reconciler saw the new run_id ` +
      `${(timings.detectedAfterStartMs / 1000).toFixed(1)} s after it started and rebuilt ${log.dropsRebuilt} ` +
      `tracked drops in ${timings.rebuildMs} ms (run_id ${before.runId.slice(0, 8)} -> ` +
      `${identity?.live.slice(0, 8)}, drop gen ${before.gen} -> ${gen})`,
  );
  ctx.record('redis', {
    ...timings,
    runIdBefore: before.runId,
    runIdAfter: identity?.live,
    dropGenBefore: before.gen,
    dropGenAfter: gen,
    dropsRebuilt: log.dropsRebuilt,
    reconcilerReason: log.detected?.reason,
    stockOnReturn: onReturn,
  });
  return onReturn ?? null;
}

/** After quiescence: the restart was detected and repaired as §4.7 says, and reserves failed closed meanwhile. */
export async function verifyRedisRecovery(
  ctx: ChaosContext,
  burst: BurstResult,
  killedAt: number,
  before: RedisBefore,
): Promise<string[]> {
  const problems: string[] = [];
  if ((burst.retries['503'] ?? 0) === 0) {
    problems.push('no reserve answered 503 while Redis was down: the fault missed the burst');
  }
  const gen = await redisGeneration(ctx.stores, ctx.drop.dropId);
  if (gen <= before.gen) problems.push(`the drop was not rebuilt: redis_gen still ${gen}`);
  const log = await recoveryLog(killedAt);
  if (log.detected === undefined) problems.push('the reconciler never logged the keyspace loss');
  else if (log.detected.reason !== 'restart') {
    problems.push(`the reconciler saw a keyspace loss of kind ${String(log.detected.reason)}, not a restart`);
  }
  if (log.rebuilt === undefined) problems.push('the reconciler never logged the finished rebuild');
  return problems;
}
