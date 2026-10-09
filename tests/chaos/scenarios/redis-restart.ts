import { setTimeout as sleep } from 'node:timers/promises';
import { killService, startServices } from '../../../tools/system/support';
import type { Scenario } from '../harness';
import { type RedisBefore, redisBefore, startRedisAndAwaitRebuild, verifyRedisRecovery } from './redis';

/*
 * `redis-restart` (design §13 core chaos case, §16 M9): Redis dies mid-burst, the way a crash ends it
 * (SIGKILL: no final AOF fsync, so up to the last second of acknowledged writes may be gone), and comes back
 * 5 s later from its AOF. See ./redis.ts for what must happen meanwhile and after.
 */

/** Long enough for every lane of the burst to meet the outage and for every client to see the socket die. */
const DOWN_MS = 5_000;

let killedAt = 0;
let before: RedisBefore | undefined;

export const redisRestart: Scenario = {
  name: 'redis-restart',
  fault: 'SIGKILL Redis mid-burst and start it again 5 s later from its AOF',
  async inject(ctx) {
    before = await redisBefore(ctx);
    await killService('redis');
    killedAt = Date.now();
    ctx.log(`SIGKILL redis (run_id ${before.runId.slice(0, 8)}); reserves fail closed while it is down`);
    await sleep(DOWN_MS);
    await startRedisAndAwaitRebuild(ctx, before, killedAt);
  },
  async verify(ctx, burst) {
    if (before === undefined) return ['the fault was never injected'];
    return verifyRedisRecovery(ctx, burst, killedAt, before);
  },
  restore: () => startServices('redis'),
};
