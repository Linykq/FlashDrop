import type { PinnedDrop } from '@flashdrop/contracts';
import { type Db, drops, inArray, rooms, sql } from '@flashdrop/db';
import { publicDropStatus } from './drop-status';

/*
 * The drop a live room is selling (the gateway's `room:<roomId>` topic, design §7, and the live page's
 * SSR), read from Postgres: drop status is decided there, and the scheduler's room publish is only a nudge
 * to read it again.
 */

export interface RoomReader {
  /**
   * Per room asked for: its LIVE or PAUSED drop, else its next SCHEDULED one, else the one that ended last;
   * null if none. One statement for all of them, so every gateway re-reads all its rooms at once.
   */
  pinnedDrops(roomIds: readonly string[]): Promise<Map<string, PinnedDrop | null>>;
}

export function createPostgresRoomReader(db: Db): RoomReader {
  return {
    async pinnedDrops(roomIds) {
      const ids = [...new Set(roomIds)];
      const pinned = new Map<string, PinnedDrop | null>(ids.map((id) => [id, null]));
      if (ids.length === 0) return pinned;
      // DISTINCT ON keeps each room's first row in this order. The status test is a literal, as in the
      // partial index `drops_room_id`, so the planner can use it whatever the plan.
      const rows = await db
        .selectDistinctOn([drops.roomId], { roomId: drops.roomId, dropId: drops.id, status: drops.status })
        .from(drops)
        .where(sql`${inArray(drops.roomId, ids)} AND ${drops.status} <> 'DRAFT'`)
        .orderBy(
          drops.roomId,
          sql`CASE ${drops.status} WHEN 'SCHEDULED' THEN 1 WHEN 'ENDED' THEN 2 ELSE 0 END`,
          // Open drops: the earliest first. Ended ones: the latest first (only ENDED rows have a key here).
          sql`CASE WHEN ${drops.status} <> 'ENDED' THEN ${drops.startsAt} END ASC`,
          sql`${drops.endsAt} DESC`,
          drops.id,
        );
      for (const row of rows) {
        // The filter names only these rooms, so the id is one of them.
        if (row.roomId !== null) {
          pinned.set(row.roomId, { dropId: row.dropId, status: publicDropStatus(row.status) });
        }
      }
      return pinned;
    },
  };
}

/** The room's pinned drop: `pinnedDrops` for one room. */
export async function pinnedDropOf(reader: RoomReader, roomId: string): Promise<PinnedDrop | null> {
  return (await reader.pinnedDrops([roomId])).get(roomId) ?? null;
}

/** Which of the given ids name a drop, and which a room: the gateway's topic directory (`ws/directory.ts`). */
export interface TopicIdLookup {
  existing(ids: {
    readonly drops: readonly string[];
    readonly rooms: readonly string[];
  }): Promise<{ readonly drops: ReadonlySet<string>; readonly rooms: ReadonlySet<string> }>;
}

/** Primary-key lookups, one statement per table however many ids are asked. */
export function createPostgresTopicIdLookup(db: Db): TopicIdLookup {
  return {
    async existing(ids) {
      const [dropRows, roomRows] = await Promise.all([
        ids.drops.length === 0
          ? []
          : db
              .select({ id: drops.id })
              .from(drops)
              .where(inArray(drops.id, [...ids.drops])),
        ids.rooms.length === 0
          ? []
          : db
              .select({ id: rooms.id })
              .from(rooms)
              .where(inArray(rooms.id, [...ids.rooms])),
      ]);
      return {
        drops: new Set(dropRows.map((row) => row.id)),
        rooms: new Set(roomRows.map((row) => row.id)),
      };
    },
  };
}
