import { createLogger } from '@flashdrop/config';
import { describe, expect, it, vi } from 'vitest';
import type { TopicIdLookup } from '../services/rooms';
import { createTopicDirectory } from './directory';

const DROP = '5eed0004-0000-4000-8000-000000000001';
const ROOM = '5eed0002-0000-4000-8000-000000000001';
const GHOST = '0198a3c4-0000-7000-8000-00000000dead';
const log = createLogger({ name: 'directory-test', level: 'silent' });

function lookupOf(drops: readonly string[], rooms: readonly string[]) {
  const calls: { drops: string[]; rooms: string[] }[] = [];
  let failing = false;
  const lookup: TopicIdLookup = {
    async existing(ids) {
      calls.push({ drops: [...ids.drops], rooms: [...ids.rooms] });
      if (failing) throw new Error('connection terminated');
      return {
        drops: new Set(ids.drops.filter((id) => drops.includes(id))),
        rooms: new Set(ids.rooms.filter((id) => rooms.includes(id))),
      };
    },
  };
  return {
    lookup,
    calls,
    fail(on: boolean) {
      failing = on;
    },
  };
}

describe('createTopicDirectory', () => {
  it('looks up the ids of one tick in one batch, by table, and remembers drops and rooms that exist', async () => {
    const source = lookupOf([DROP], [ROOM]);
    const directory = createTopicDirectory({ lookup: source.lookup, log });
    const answers = await Promise.all([
      directory.exists('stock', DROP),
      directory.exists('dash', DROP),
      directory.exists('room', ROOM),
      directory.exists('stock', GHOST),
      // A room id is not a drop id.
      directory.exists('stock', ROOM),
    ]);
    expect(answers).toEqual([true, true, true, false, false]);
    expect(source.calls).toEqual([{ drops: [DROP, GHOST, ROOM], rooms: [ROOM] }]);

    await expect(directory.exists('stock', DROP)).resolves.toBe(true);
    await expect(directory.exists('room', ROOM)).resolves.toBe(true);
    expect(source.calls).toHaveLength(1);
  });

  it('remembers a missing id briefly, then asks again', async () => {
    let now = 1_000;
    const source = lookupOf([], []);
    const directory = createTopicDirectory({ lookup: source.lookup, log, now: () => now, missTtlMs: 5_000 });
    await expect(directory.exists('stock', GHOST)).resolves.toBe(false);
    await expect(directory.exists('stock', GHOST)).resolves.toBe(false);
    expect(source.calls).toHaveLength(1);
    now += 5_000;
    await expect(directory.exists('stock', GHOST)).resolves.toBe(false);
    expect(source.calls).toHaveLength(2);
  });

  it('keeps one lookup in flight: ids asked meanwhile wait for the next batch', async () => {
    const source = lookupOf([DROP], []);
    const gate = Promise.withResolvers<void>();
    const existing = source.lookup.existing;
    const slow: TopicIdLookup = {
      existing: vi.fn(async (ids) => {
        await gate.promise;
        return existing(ids);
      }),
    };
    const directory = createTopicDirectory({ lookup: slow, log });
    const first = directory.exists('stock', DROP);
    await Promise.resolve();
    const later = [directory.exists('stock', GHOST), directory.exists('room', ROOM)];
    await Promise.resolve();
    expect(slow.existing).toHaveBeenCalledTimes(1);
    gate.resolve();
    await expect(Promise.all([first, ...later])).resolves.toEqual([true, false, false]);
    expect(source.calls).toEqual([
      { drops: [DROP], rooms: [] },
      { drops: [GHOST], rooms: [ROOM] },
    ]);
  });

  it('lets topics through while Postgres does not answer, and remembers nothing of it', async () => {
    const source = lookupOf([], []);
    const directory = createTopicDirectory({ lookup: source.lookup, log });
    source.fail(true);
    await expect(directory.exists('stock', GHOST)).resolves.toBe(true);
    source.fail(false);
    await expect(directory.exists('stock', GHOST)).resolves.toBe(false);
    expect(source.calls).toHaveLength(2);
  });

  it('bounds what it remembers', async () => {
    const ids = Array.from({ length: 3 }, (_, i) => `5eed0004-0000-4000-8000-00000000000${i}`);
    const source = lookupOf(ids, []);
    const directory = createTopicDirectory({ lookup: source.lookup, log, maxKnown: 2 });
    for (const id of ids) await directory.exists('stock', id);
    expect(source.calls).toHaveLength(3);
    // The oldest was forgotten; the newest two are still known.
    await directory.exists('stock', ids[2] ?? '');
    await directory.exists('stock', ids[1] ?? '');
    expect(source.calls).toHaveLength(3);
    await directory.exists('stock', ids[0] ?? '');
    expect(source.calls).toHaveLength(4);
  });
});
