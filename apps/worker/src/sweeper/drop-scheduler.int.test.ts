import { randomUUID } from 'node:crypto';
import { RoomChangedMessage } from '@flashdrop/contracts';
import { drops, eq, rooms } from '@flashdrop/db';
import { createSubscriber, roomChannel } from '@flashdrop/inventory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armDrop, createDrop, createWorkerTestEnv, eventually, type WorkerTestEnv } from '../test/harness';
import { dropScheduler } from './drop-scheduler';

/*
 * The scheduler's nudges (design §4.6, §7, §8.1): on a Postgres transition it publishes on the drop's room
 * channel, which every gateway holding the room answers by re-reading the room's pinned drop, and asks `web`
 * to revalidate its cached drop list.
 */

let env: WorkerTestEnv;
const running = new AbortController().signal;

beforeAll(async () => {
  env = await createWorkerTestEnv();
});

afterAll(async () => {
  await env?.close();
});

describe('drop-scheduler room nudges', () => {
  it('publishes the transition on the room channel of a drop sold in a live room', async () => {
    const roomId = randomUUID();
    await env.db
      .insert(rooms)
      .values({ id: roomId, slug: `room-${roomId}`, title: 'Scheduler room', hlsUrl: '/hls/live.m3u8' });
    const inRoom = await createDrop(env, { status: 'SCHEDULED', startsIn: -1 });
    await env.db.update(drops).set({ roomId }).where(eq(drops.id, inRoom));
    // Transitions too, but sells without a room: nothing to announce.
    const roomless = await createDrop(env, { status: 'SCHEDULED', startsIn: -1 });
    await armDrop(env, inRoom);
    await armDrop(env, roomless);

    const subscriber = createSubscriber(env.redis, { name: 'scheduler-room-test', logger: env.deps.logger });
    const heard: RoomChangedMessage[] = [];
    try {
      await subscriber.connect();
      await subscriber.subscribe(roomChannel(roomId), (message: string) => {
        heard.push(RoomChangedMessage.parse(JSON.parse(message)));
      });

      await dropScheduler(env.deps, running);

      await eventually(async () => heard.length > 0, 2_000);
      expect(heard).toEqual([{ type: 'drop', dropId: inRoom, status: 'LIVE' }]);
    } finally {
      subscriber.destroy();
    }
  });
});

describe('drop-scheduler web revalidation', () => {
  it('asks web to revalidate `drops` once for a tick with transitions, and not for an idle tick', async () => {
    const tags: string[] = [];
    const deps = { ...env.deps, revalidate: async (tag: string) => void tags.push(tag) };
    await armDrop(env, await createDrop(env, { status: 'SCHEDULED', startsIn: -1 }));
    await armDrop(env, await createDrop(env, { status: 'SCHEDULED', startsIn: -1 }));

    await dropScheduler(deps, running);
    expect(tags).toEqual(['drops']);

    await dropScheduler(deps, running);
    expect(tags).toEqual(['drops']);
  });
});
