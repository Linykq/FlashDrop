import { type FlashdropRedis, REDIS_DEADLINE_MS, viewersKey, withDeadline } from '@flashdrop/inventory';

/*
 * Viewer count (design §7): `fd:viewers:<roomId>` holds one field per gateway instance, its socket count on
 * the room, each field with its own 15 s TTL. Gateways rewrite their field every 5 s, so the count is the sum
 * of the live fields and a crashed gateway ages out on its own.
 *
 * The field and its TTL are written by one HSETEX (Redis 8.0+), not HSET then HEXPIRE: a process that died
 * between the two would leave a field without a TTL, counted forever.
 */

/** Three missed rewrites, so one slow tick never drops an instance's viewers. */
export const VIEWER_FIELD_TTL_SECONDS = 15;

export interface ViewerStore {
  /**
   * Writes this instance's count for every room in `counts`, deletes its field for each room in `gone`, and
   * returns the total across instances for every room in `counts`.
   */
  report(counts: ReadonlyMap<string, number>, gone: readonly string[]): Promise<Map<string, number>>;
}

function total(values: readonly string[]): number {
  let sum = 0;
  for (const value of values) {
    const n = Number(value);
    // Only gateways write these fields, as integers; anything else is not a count.
    if (Number.isSafeInteger(n) && n > 0) sum += n;
  }
  return sum;
}

export function createRedisViewerStore(redis: FlashdropRedis, instanceId: string): ViewerStore {
  return {
    report: (counts, gone) =>
      withDeadline('viewer report', REDIS_DEADLINE_MS, async () => {
        const rooms = [...counts];
        // Issued together, so node-redis pipelines them: one round trip, and each room's write is ordered
        // before its read on the connection.
        const writes = rooms.map(([roomId, n]) =>
          redis.hSetEx(
            viewersKey(roomId),
            { [instanceId]: n },
            {
              expiration: { type: 'EX', value: VIEWER_FIELD_TTL_SECONDS },
            },
          ),
        );
        const deletes = gone.map((roomId) => redis.hDel(viewersKey(roomId), instanceId));
        const reads = rooms.map(([roomId]) => redis.hVals(viewersKey(roomId)));
        const [, , values] = await Promise.all([
          Promise.all(writes),
          Promise.all(deletes),
          Promise.all(reads),
        ]);
        return new Map(rooms.map(([roomId], i) => [roomId, total(values[i] ?? [])]));
      }),
  };
}
