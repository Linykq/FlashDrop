import type { TopicKind } from '@flashdrop/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { TopicIdLookup } from '../services/rooms';

/*
 * Which topics name something that exists (design §7): a `stock:` or `dash:` topic a drop, a `room:` topic
 * a room. The gateway answers any other with NOT_FOUND and keeps no state for it, so a client cannot make
 * it read Postgres every few seconds and write Redis for ids it invents.
 *
 * - Drops and rooms are never deleted, so an id found once is remembered (up to a bound). An id not found is
 *   remembered for a few seconds, for a client that repeats it.
 * - Ids not seen before are looked up in batches, one batch in flight per instance: however many sockets
 *   ask, and however many ids they invent, one primary-key statement per table runs at a time.
 * - Fail open: while Postgres does not answer, ids are let through and nothing is remembered. A stock topic
 *   needs only Redis, so an outage must not take live stock down with it; the gateway's per-socket join
 *   budget still bounds what one client can ask for meanwhile.
 */

export interface TopicDirectory {
  /** Whether the topic's drop or room exists. Never rejects. */
  exists(kind: TopicKind, id: string): Promise<boolean>;
}

export interface TopicDirectoryOptions {
  readonly lookup: TopicIdLookup;
  readonly log: FastifyBaseLogger;
  readonly now?: () => number;
  /** How long an id that was not found is answered from memory. */
  readonly missTtlMs?: number;
  /** Ids remembered as existing, per table; the oldest are forgotten first. */
  readonly maxKnown?: number;
  /** Ids remembered as missing, per table. */
  readonly maxMissing?: number;
  /** Ids per lookup statement. */
  readonly maxBatch?: number;
}

export const TOPIC_DIRECTORY_DEFAULTS = {
  missTtlMs: 5_000,
  maxKnown: 50_000,
  maxMissing: 10_000,
  maxBatch: 500,
} as const;

type Table = 'drops' | 'rooms';

interface Waiting {
  readonly table: Table;
  readonly id: string;
  readonly answers: ((found: boolean) => void)[];
}

const tableOf = (kind: TopicKind): Table => (kind === 'room' ? 'rooms' : 'drops');

/** Adds to a bounded set or map, forgetting the oldest entry when full (insertion order). */
function bounded<K>(entries: Set<K> | Map<K, number>, max: number): void {
  if (entries.size < max) return;
  const oldest = entries.keys().next();
  if (oldest.done !== true) entries.delete(oldest.value);
}

export function createTopicDirectory(options: TopicDirectoryOptions): TopicDirectory {
  const { lookup, log } = options;
  const now = options.now ?? Date.now;
  const missTtlMs = options.missTtlMs ?? TOPIC_DIRECTORY_DEFAULTS.missTtlMs;
  const maxKnown = options.maxKnown ?? TOPIC_DIRECTORY_DEFAULTS.maxKnown;
  const maxMissing = options.maxMissing ?? TOPIC_DIRECTORY_DEFAULTS.maxMissing;
  const maxBatch = options.maxBatch ?? TOPIC_DIRECTORY_DEFAULTS.maxBatch;
  const known: Record<Table, Set<string>> = { drops: new Set(), rooms: new Set() };
  /** Id -> until when it counts as missing. */
  const missing: Record<Table, Map<string, number>> = { drops: new Map(), rooms: new Map() };
  const waiting = new Map<string, Waiting>();
  let running = false;

  function settle(entry: Waiting, found: boolean): void {
    for (const answer of entry.answers) answer(found);
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (waiting.size > 0) {
        const batch = [...waiting.entries()].slice(0, maxBatch);
        for (const [key] of batch) waiting.delete(key);
        const entries = batch.map(([, entry]) => entry);
        const idsOf = (table: Table) => entries.filter((e) => e.table === table).map((e) => e.id);
        let found: Awaited<ReturnType<TopicIdLookup['existing']>>;
        try {
          found = await lookup.existing({ drops: idsOf('drops'), rooms: idsOf('rooms') });
        } catch (err) {
          log.warn({ err, ids: entries.length }, 'topic lookup failed; letting the topics through');
          for (const entry of entries) settle(entry, true);
          continue;
        }
        const until = now() + missTtlMs;
        for (const entry of entries) {
          const hit = found[entry.table].has(entry.id);
          if (hit) {
            bounded(known[entry.table], maxKnown);
            known[entry.table].add(entry.id);
          } else {
            bounded(missing[entry.table], maxMissing);
            missing[entry.table].set(entry.id, until);
          }
          settle(entry, hit);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    exists(kind, id) {
      const table = tableOf(kind);
      if (known[table].has(id)) return Promise.resolve(true);
      const missingUntil = missing[table].get(id);
      if (missingUntil !== undefined) {
        if (missingUntil > now()) return Promise.resolve(false);
        missing[table].delete(id);
      }
      return new Promise((resolve) => {
        const key = `${table}:${id}`;
        let entry = waiting.get(key);
        if (entry === undefined) {
          entry = { table, id, answers: [] };
          waiting.set(key, entry);
        }
        entry.answers.push(resolve);
        // On the next microtask, so every topic of one `sub` frame goes into the same batch.
        queueMicrotask(() => void drain());
      });
    },
  };
}
