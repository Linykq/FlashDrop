import { type RedisStock, redisStock } from '../../../tools/system/chaos-support';
import { compose, killService, startServices, until } from '../../../tools/system/support';
import type { Scenario } from '../harness';
import { type RedisBefore, redisBefore, startRedisAndAwaitRebuild, verifyRedisRecovery } from './redis';

/*
 * The `redis-restart` variant with a lost AOF tail (design §4.7, §17): Redis comes back from an older copy of
 * its AOF, so writes it had acknowledged are gone. A copy of the AOF directory is taken mid-burst (while
 * Redis appends to it, so its last command may be cut off, which `aof-load-truncated yes` repairs on load,
 * exactly as after a crash mid-write); the burst then keeps reserving, cancelling and settling for a while,
 * and Redis is killed and restarted from the copy. Those holds and settlements are what Redis loses: seconds
 * of them, where `appendfsync everysec` risks one. Until the reconciler notices the new `run_id`, Redis may
 * be optimistic (INV-7 allows that detection window); Postgres refuses whatever would oversell, and the
 * rebuild restores every drop from Postgres.
 */

const AOF_DIR = '/data/appendonlydir';
const COPY_DIR = '/data/chaos-aof-copy';
/** Orders won after the copy: acknowledged writes that Redis will have lost. */
const TAIL_ORDERS = 40;

let killedAt = 0;
let before: RedisBefore | undefined;
let atKill: RedisStock | null = null;
let onReturn: RedisStock | null = null;

async function aofBytes(dir: string): Promise<number> {
  const out = await compose(['exec', '-T', 'redis', 'du', '-sb', dir]);
  const bytes = Number(out.trim().split(/\s+/)[0]);
  if (!Number.isInteger(bytes)) throw new Error(`du of ${dir} printed ${JSON.stringify(out)}`);
  return bytes;
}

export const redisLostTail: Scenario = {
  name: 'redis-lost-tail',
  fault: 'restart Redis mid-burst from an AOF copy taken seconds earlier: a lost tail of acknowledged writes',
  async inject(ctx) {
    await compose(['exec', '-T', 'redis', 'sh', '-c', `rm -rf ${COPY_DIR} && cp -a ${AOF_DIR} ${COPY_DIR}`]);
    const copy = { aofBytes: await aofBytes(COPY_DIR), stock: await redisStock(ctx.stores, ctx.drop.dropId) };
    const wonAtCopy = ctx.burst.progress().won;
    ctx.log(`AOF copied (${copy.aofBytes} bytes); the burst writes on, and that tail will be lost`);
    await until(
      `${TAIL_ORDERS} more orders won after the copy`,
      async () => ctx.burst.progress().won,
      (won) => won >= wonAtCopy + TAIL_ORDERS,
      60_000,
    );

    before = await redisBefore(ctx);
    const killBytes = await aofBytes(AOF_DIR);
    atKill = await redisStock(ctx.stores, ctx.drop.dropId);
    await killService('redis');
    killedAt = Date.now();
    // A one-off container of the redis service mounts the same volume while the server is down.
    await compose([
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'sh',
      'redis',
      '-c',
      `rm -rf ${AOF_DIR} && mv ${COPY_DIR} ${AOF_DIR}`,
    ]);
    const tailOrders = ctx.burst.progress().won - wonAtCopy;
    ctx.log(
      `SIGKILL redis and put the older AOF back: ${killBytes - copy.aofBytes} bytes of tail dropped, ` +
        `${tailOrders} orders won since the copy`,
    );
    ctx.record('lostTail', {
      aofBytesAtCopy: copy.aofBytes,
      aofBytesAtKill: killBytes,
      bytesLost: killBytes - copy.aofBytes,
      ordersWonAfterCopy: tailOrders,
      stockAtCopy: copy.stock,
      stockAtKill: atKill,
    });
    onReturn = await startRedisAndAwaitRebuild(ctx, before, killedAt);
  },
  async verify(ctx, burst) {
    if (before === undefined || atKill === null || onReturn === null) return ['the fault was never injected'];
    // Evidence only, since it races the reconciler: Redis serving the drop's older state (the same generation,
    // an older sequence: the tail really was gone), or the rebuild already done (a newer generation).
    ctx.record(
      'cameBackWith',
      onReturn.gen > atKill.gen
        ? 'the rebuild (the reconciler was faster than the evidence client)'
        : onReturn.seq < atKill.seq
          ? `the pre-tail state: seq ${onReturn.seq} where it was ${atKill.seq} at the kill`
          : `gen ${onReturn.gen} seq ${onReturn.seq} (at the kill: gen ${atKill.gen} seq ${atKill.seq})`,
    );
    return verifyRedisRecovery(ctx, burst, killedAt, before);
  },
  async restore() {
    await startServices('redis');
    await compose(['exec', '-T', 'redis', 'rm', '-rf', COPY_DIR]);
  },
};
