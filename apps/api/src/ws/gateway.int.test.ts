import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SESSION_COOKIE } from '@flashdrop/config/constants';
import {
  type ClientMessage,
  SALES_COUNTERS,
  ServerMessage,
  type Topic,
  topicOf,
  WS_CLOSE,
  WS_MAX_PAYLOAD_BYTES,
} from '@flashdrop/contracts';
import { drops, eq, products, rooms, seedId } from '@flashdrop/db';
import { requestFingerprint } from '@flashdrop/domain/identity';
import {
  dashboardChannel,
  dropKeys,
  type FlashdropRedis,
  fdRebuild,
  fdReserve,
  fdSetStatus,
  stockChannel,
  userChannel,
  viewersKey,
} from '@flashdrop/inventory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Api } from '../http/api';
import { createSessionCodec } from '../http/session';
import { ADMIN, BUYER, ORIGIN, SECRET } from '../test/fakes';
import { createTestStack, type TestStack } from '../test/stack';
import type { GatewayLimits } from './gateway';

/*
 * Two gateway instances in one process, as api-1 and api-2, over the tests' real Redis and a throwaway
 * Postgres: cross-instance fan-out, coalescing, the resubscribe re-snapshot, viewer counts, a real stalled
 * socket and the abuse limits. Drops here are armed in Redis directly (fresh ids), so nothing else on the
 * shared Redis is touched; each also gets a DRAFT row in Postgres, because the gateway refuses topics of
 * drops that do not exist.
 */

const RUN = randomUUID().slice(0, 8);
const LIVE_DROP = seedId(4, 1);

let stack: TestStack;
let redis: FlashdropRedis;
const urls: Record<'one' | 'two' | 'tight' | 'capped', string> = { one: '', two: '', tight: '', capped: '' };
const instanceIds = {
  one: `int-ws-1-${RUN}`,
  two: `int-ws-2-${RUN}`,
  tight: `int-ws-3-${RUN}`,
  capped: `int-ws-4-${RUN}`,
};
const redisDrops: string[] = [];
let room: string;

async function serve(
  instanceId: string,
  limits: Partial<GatewayLimits>,
  options: { readonly maxSocketsPerAddress?: number } = {},
): Promise<string> {
  const app: Api = await stack.build({
    roles: ['ws'],
    realtime: { ...stack.wired.realtime, instanceId, limits, ...options },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}/ws`;
}

/** DRAFT drops in Postgres with these ids: enough for the gateway's directory, invisible to everything else. */
async function pgDrops(dropIds: readonly string[]): Promise<void> {
  const productId = randomUUID();
  await stack.database.db.insert(products).values({
    id: productId,
    slug: `ws-int-${productId}`,
    title: 'WebSocket integration product',
    description: 'Exists only in this test database.',
    imageKeys: [],
    status: 'PUBLISHED',
  });
  const now = Date.now();
  await stack.database.db.insert(drops).values(
    dropIds.map((id) => ({
      id,
      productId,
      startsAt: new Date(now + 3_600_000),
      endsAt: new Date(now + 7_200_000),
      priceCents: 1999,
      perUserLimit: 2,
      status: 'DRAFT' as const,
    })),
  );
}

/** A drop armed in Redis the way `syncDropFromPostgres` arms one, with a DRAFT row in Postgres. */
async function redisDrop(total = 100): Promise<string> {
  const dropId = randomUUID();
  redisDrops.push(dropId);
  await pgDrops([dropId]);
  const now = Date.now();
  await fdSetStatus(redis, dropId, 'RECONCILING');
  const rebuilt = await fdRebuild(redis, dropId, {
    gen: 1,
    total,
    reserved: 0,
    sold: 0,
    meta: {
      status: 'LIVE',
      startsAt: now - 3_600_000,
      endsAt: now + 3_600_000,
      holdMs: 120_000,
      limit: 2,
      retainAt: now + 600_000,
      productId: randomUUID(),
    },
    entries: [],
    quotas: {},
  });
  if (rebuilt.kind !== 'OK') throw new Error(`test drop rebuild answered ${rebuilt.kind}`);
  return dropId;
}

async function reserve(dropId: string): Promise<void> {
  const rid = randomUUID();
  const result = await fdReserve(redis, {
    dropId,
    rid,
    userId: randomUUID(),
    qty: 1,
    fingerprint: requestFingerprint({ dropId, qty: 1 }),
    idempotencyKey: `key_${rid.slice(0, 8)}`,
  });
  if (result.kind !== 'RESERVED') throw new Error(`reserve answered ${result.kind}`);
}

interface Client {
  readonly socket: WebSocket;
  readonly frames: ServerMessage[];
  send(message: ClientMessage): void;
  /** The first frame, from the start of the connection, that matches. */
  waitFor(match: (frame: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  readonly closed: Promise<{ code: number; reason: string }>;
}

const clients: Client[] = [];

async function connect(url: string, options: { cookie?: string; origin?: string } = {}): Promise<Client> {
  const socket = new WebSocket(url, {
    headers: {
      origin: options.origin ?? ORIGIN,
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
  });
  const frames: ServerMessage[] = [];
  const waiters = new Set<() => void>();
  socket.on('message', (data) => {
    frames.push(ServerMessage.parse(JSON.parse(String(data))));
    for (const waiter of waiters) waiter();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const client: Client = {
    socket,
    frames,
    closed,
    send: (message) => socket.send(JSON.stringify(message)),
    waitFor(match, timeoutMs = 5_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = frames.find(match);
          if (found === undefined) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(found);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`no matching frame within ${timeoutMs} ms; got ${JSON.stringify(frames)}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
  };
  clients.push(client);
  return client;
}

async function cookieOf(user: typeof ADMIN): Promise<string> {
  return `${SESSION_COOKIE}=${await createSessionCodec(SECRET).issue(user)}`;
}

const isSnapshot = (topic: Topic) => (frame: ServerMessage) =>
  frame.type === 'snapshot' && frame.topic === topic;
const deltaWith = (topic: Topic, seq: number) => (frame: ServerMessage) =>
  frame.type === 'delta' && frame.topic === topic && frame.seq >= seq;
const hello = (client: Client) => client.waitFor((frame) => frame.type === 'hello');

beforeAll(async () => {
  stack = await createTestStack();
  redis = stack.redis;
  // A room of this run only, selling the seed's LIVE drop: viewer fields of other runs cannot leak in.
  room = randomUUID();
  await stack.database.db
    .insert(rooms)
    .values({ id: room, slug: `room-${RUN}`, title: 'Integration room', hlsUrl: '/hls/live.m3u8' });
  await stack.database.db.update(drops).set({ roomId: room }).where(eq(drops.id, LIVE_DROP));

  const quickViewers = { viewerIntervalMs: 200 };
  urls.one = await serve(instanceIds.one, quickViewers);
  urls.two = await serve(instanceIds.two, quickViewers);
  urls.tight = await serve(instanceIds.tight, {
    flushIntervalMs: 10,
    skipAboveBytes: 16 * 1024,
    closeAboveBytes: 64 * 1024 * 1024,
    stallCloseMs: 500,
    watchdogIntervalMs: 100,
  });
  urls.capped = await serve(
    instanceIds.capped,
    { beatIntervalMs: 300, watchdogIntervalMs: 50 },
    {
      maxSocketsPerAddress: 2,
    },
  );
});

afterAll(async () => {
  for (const client of clients) client.socket.terminate();
  for (const dropId of redisDrops) {
    const k = dropKeys(dropId);
    await redis.del([k.inv, k.rsv, k.uq, k.exp]);
  }
  await redis.del(viewersKey(room));
  await stack.close();
});

describe('upgrade', () => {
  it.each([
    ['another site', 'https://evil.example'],
    ['no Origin header', undefined],
  ])('refuses a handshake from %s with 403', async (_, origin) => {
    const socket = new WebSocket(urls.one, origin === undefined ? {} : { headers: { origin } });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      socket.once('unexpected-response', (request, response) => {
        resolve(response.statusCode);
        request.destroy();
      });
      socket.once('open', () => {
        resolve(undefined);
        socket.terminate();
      });
      // Only before the outcome: destroying the refused handshake's request errors the socket too.
      socket.once('error', reject);
    });
    expect(status).toBe(403);
  });

  it('closes a socket that sends a frame over 4 KB with 1009', async () => {
    const client = await connect(urls.one);
    await hello(client);
    client.socket.send(
      JSON.stringify({ type: 'sub', topics: [], padding: 'x'.repeat(WS_MAX_PAYLOAD_BYTES) }),
    );
    await expect(client.closed).resolves.toMatchObject({ code: 1009 });
  });
});

describe('cross-instance fan-out (§7)', () => {
  it('delivers one drop to sockets on both instances, coalesced, with the Redis mutation time', async () => {
    const dropId = await redisDrop();
    const topic = topicOf('stock', dropId);
    const [a, b] = await Promise.all([connect(urls.one), connect(urls.two)]);
    const [helloA, helloB] = await Promise.all([hello(a), hello(b)]);
    expect(helloA).toMatchObject({ instanceId: instanceIds.one });
    expect(helloB).toMatchObject({ instanceId: instanceIds.two });

    for (const client of [a, b]) client.send({ type: 'sub', topics: [topic] });
    const snapshots = await Promise.all([a.waitFor(isSnapshot(topic)), b.waitFor(isSnapshot(topic))]);
    for (const snapshot of snapshots) {
      expect(snapshot).toMatchObject({
        gen: 1,
        seq: 0,
        data: { avail: 100, held: 0, sold: 0, status: 'LIVE' },
      });
    }

    const started = Date.now();
    for (let i = 0; i < 40; i += 1) await reserve(dropId);
    const [lastA, lastB] = await Promise.all([
      a.waitFor(deltaWith(topic, 40)),
      b.waitFor(deltaWith(topic, 40)),
    ]);
    const elapsed = Date.now() - started;

    for (const [client, last] of [
      [a, lastA],
      [b, lastB],
    ] as const) {
      expect(last).toMatchObject({ gen: 1, seq: 40, data: { avail: 60, held: 40, sold: 0, status: 'LIVE' } });
      // The Redis TIME of the newest mutation: the propagation metric's start.
      if (last.type !== 'delta') throw new Error('expected a delta');
      expect(Math.abs(last.ts - Date.now())).toBeLessThan(5_000);
      // Coalesced: at most one frame per 100 ms tick (plus the partial ticks at both ends).
      const deltas = client.frames.filter((frame) => frame.type === 'delta');
      expect(deltas.length).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 2);
      const seqs = deltas.map((frame) => (frame.type === 'delta' ? frame.seq : -1));
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    }
  });

  it('re-snapshots held topics when its subscriber reconnects, and pushes what pub/sub missed', async () => {
    const dropId = await redisDrop();
    const topic = topicOf('stock', dropId);
    const [a, b] = await Promise.all([connect(urls.one), connect(urls.two)]);
    for (const client of [a, b]) client.send({ type: 'sub', topics: [topic] });
    await Promise.all([a.waitFor(isSnapshot(topic)), b.waitFor(isSnapshot(topic))]);

    // A change no subscriber hears (written without a publish), then instance one's subscriber dies.
    await redis.hIncrBy(dropKeys(dropId).inv, 'seq', 5);
    const list = String(await redis.sendCommand(['CLIENT', 'LIST', 'TYPE', 'pubsub']));
    const id = new RegExp(`id=(\\d+) [^\\n]*name=api-sub:${instanceIds.one}`).exec(list)?.[1];
    expect(id).toBeDefined();
    await redis.sendCommand(['CLIENT', 'KILL', 'ID', String(id)]);

    await expect(a.waitFor(deltaWith(topic, 5))).resolves.toMatchObject({ gen: 1, seq: 5 });
    // Instance two never lost its subscription, so nothing tells it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(b.frames.some(deltaWith(topic, 5))).toBe(false);

    // And instance one is subscribed again: the next publish arrives as usual.
    await reserve(dropId);
    await expect(a.waitFor(deltaWith(topic, 6))).resolves.toMatchObject({ seq: 6, data: { avail: 99 } });
  });
});

describe('room topic', () => {
  it('shows the pinned drop and the viewers of both instances, on both', async () => {
    const topic = topicOf('room', room);
    const viewersAre = (n: number) => (frame: ServerMessage) =>
      (frame.type === 'snapshot' || frame.type === 'delta') &&
      frame.topic === topic &&
      typeof frame.data === 'object' &&
      frame.data !== null &&
      'viewers' in frame.data &&
      frame.data.viewers === n;
    const a = await connect(urls.one);
    a.send({ type: 'sub', topics: [topic] });
    await expect(a.waitFor(isSnapshot(topic))).resolves.toMatchObject({
      gen: 0,
      data: { pinned: { dropId: LIVE_DROP, status: 'LIVE' }, viewers: 1 },
    });

    const b = await connect(urls.two);
    b.send({ type: 'sub', topics: [topic] });
    await Promise.all([a.waitFor(viewersAre(2)), b.waitFor(viewersAre(2))]);

    // Leaving: instance two deletes its field at its next beat, and instance one sees the total drop.
    const before = a.frames.length;
    b.socket.close();
    await a.waitFor((frame) => a.frames.indexOf(frame) >= before && viewersAre(1)(frame));
  });
});

describe('private topics', () => {
  it('gives the dash topic to admins only, starting from the projection', async () => {
    const dropId = randomUUID();
    await pgDrops([dropId]);
    const topic = topicOf('dash', dropId);
    const anonymous = await connect(urls.one);
    anonymous.send({ type: 'sub', topics: [topic] });
    await expect(anonymous.waitFor((frame) => frame.type === 'error')).resolves.toEqual({
      type: 'error',
      code: 'FORBIDDEN',
      topics: [topic],
    });

    const admin = await connect(urls.two, { cookie: await cookieOf(ADMIN) });
    admin.send({ type: 'sub', topics: [topic] });
    await expect(admin.waitFor(isSnapshot(topic))).resolves.toMatchObject({ gen: 0, seq: 0 });

    const totals = {
      ...Object.fromEntries(SALES_COUNTERS.map((counter) => [counter, 0])),
      paid: 1,
      lastEventAt: null,
    };
    await redis.publish(dashboardChannel(dropId), JSON.stringify({ version: 1, totals }));
    await expect(admin.waitFor(deltaWith(topic, 1))).resolves.toMatchObject({ seq: 1, data: totals });
  });

  it("sends a buyer their own order events, and nobody else's", async () => {
    const buyer = await connect(urls.one, { cookie: await cookieOf(BUYER) });
    const admin = await connect(urls.two, { cookie: await cookieOf(ADMIN) });
    await Promise.all([hello(buyer), hello(admin)]);
    const event = { type: 'order', orderId: randomUUID(), status: 'PAID', version: 3 } as const;
    // The user channel is subscribed right after the upgrade; retry until it is.
    const deadline = Date.now() + 5_000;
    while (!buyer.frames.some((frame) => frame.type === 'order') && Date.now() < deadline) {
      await redis.publish(userChannel(BUYER.id), JSON.stringify(event));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await expect(buyer.waitFor((frame) => frame.type === 'order')).resolves.toEqual(event);
    expect(admin.frames.some((frame) => frame.type === 'order')).toBe(false);
  });
});

describe('backpressure (§7)', () => {
  it('closes a socket that stops reading with 1013 once its sends have been skipped long enough', async () => {
    const dropIds = Array.from({ length: 64 }, () => randomUUID());
    await pgDrops(dropIds);
    const topics = dropIds.map((dropId) => topicOf('stock', dropId));
    const client = await connect(urls.tight);
    client.send({ type: 'sub', topics });
    await hello(client);

    let seq = 0;
    let publishing = true;
    const publisher = (async () => {
      while (publishing) {
        seq += 1;
        const level = `1:${seq}:${1_000_000 - seq}:0:${seq}:LIVE:${Date.now()}`;
        await Promise.all(dropIds.map((dropId) => redis.publish(stockChannel(dropId), level)));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    try {
      // Every topic flowing, then the client stops reading: the kernel buffers fill, then the send buffer.
      await Promise.all(topics.map((topic) => client.waitFor(deltaWith(topic, 1))));
      client.socket.pause();
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    } finally {
      publishing = false;
      await publisher;
    }
    client.socket.resume();
    await expect(client.closed).resolves.toEqual({ code: WS_CLOSE.TRY_AGAIN_LATER, reason: 'stalled' });
  });
});

describe('abuse limits (§11)', () => {
  it('answers NOT_FOUND for a drop Postgres does not have, even one armed in Redis', async () => {
    const armed = await redisDrop();
    const ghost = randomUUID();
    const client = await connect(urls.one);
    client.send({ type: 'sub', topics: [topicOf('stock', ghost), topicOf('stock', armed)] });
    await expect(client.waitFor((frame) => frame.type === 'error')).resolves.toEqual({
      type: 'error',
      code: 'NOT_FOUND',
      topics: [topicOf('stock', ghost)],
    });
    await client.waitFor(isSnapshot(topicOf('stock', armed)));
  });

  it('refuses an upgrade with 429 once the address holds its cap of sockets here', async () => {
    const held = [await connect(urls.capped), await connect(urls.capped)];
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const socket = new WebSocket(urls.capped, { headers: { origin: ORIGIN } });
      socket.once('unexpected-response', (request, response) => {
        resolve(response.statusCode);
        request.destroy();
      });
      socket.once('open', () => {
        resolve(undefined);
        socket.terminate();
      });
      socket.once('error', reject);
    });
    expect(status).toBe(429);
    for (const client of held) client.socket.close();
    await Promise.all(held.map((client) => client.closed));
  });

  it('sends beats only to a socket that opted in with ?beat=1', async () => {
    // The previous test's sockets may still be leaving the capped instance.
    let opted: Client | undefined;
    const deadline = Date.now() + 5_000;
    while (opted === undefined) {
      opted = await connect(`${urls.capped}?beat=1`).catch((error: unknown) => {
        if (Date.now() > deadline) throw error;
        return undefined;
      });
      if (opted === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const plain = await connect(urls.capped);
    await expect(opted.waitFor((frame) => frame.type === 'beat')).resolves.toMatchObject({ type: 'beat' });
    expect(plain.frames.some((frame) => frame.type === 'beat')).toBe(false);
    for (const client of [opted, plain]) client.socket.close();
    await Promise.all([opted.closed, plain.closed]);
  });
});
