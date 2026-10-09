import { describe, expect, it } from 'vitest';
import {
  ClientMessage,
  RoomChangedMessage,
  RoomFrameData,
  ServerMessage,
  StockFrameData,
  splitTopic,
  Topic,
  topicOf,
  UserEventMessage,
  WS_MAX_TOPICS_PER_SOCKET,
} from './realtime';

const DROP = '5eed0004-0000-4000-8000-000000000001';
const ROOM = '5eed0002-0000-4000-8000-000000000001';
const JOB = '0198a3c4-1f2e-7a10-8b2c-3d4e5f607182';

describe('Topic (§7)', () => {
  it.each([`stock:${DROP}`, `room:${ROOM}`, `dash:${DROP}`])('accepts %s', (topic) => {
    expect(Topic.safeParse(topic).success).toBe(true);
  });

  it.each([
    `stock:${DROP.toUpperCase()}`,
    `user:${DROP}`,
    'stock:',
    `stock:${DROP}:x`,
    `stock ${DROP}`,
    DROP,
  ])('refuses %s', (topic) => {
    expect(Topic.safeParse(topic).success).toBe(false);
  });

  it('builds the canonical spelling and splits it back', () => {
    const topic = topicOf('dash', DROP.toUpperCase());
    expect(topic).toBe(`dash:${DROP}`);
    expect(splitTopic(topic)).toEqual({ kind: 'dash', id: DROP });
  });
});

describe('ClientMessage', () => {
  it('parses sub and unsub', () => {
    expect(ClientMessage.parse({ type: 'sub', topics: [`stock:${DROP}`] })).toEqual({
      type: 'sub',
      topics: [`stock:${DROP}`],
    });
    expect(ClientMessage.parse({ type: 'unsub', topics: [`room:${ROOM}`] }).type).toBe('unsub');
  });

  it('bounds the topic list', () => {
    const many = (n: number) => Array.from({ length: n }, () => `stock:${DROP}`);
    expect(ClientMessage.safeParse({ type: 'sub', topics: [] }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'sub', topics: many(WS_MAX_TOPICS_PER_SOCKET) }).success).toBe(
      true,
    );
    expect(ClientMessage.safeParse({ type: 'sub', topics: many(WS_MAX_TOPICS_PER_SOCKET + 1) }).success).toBe(
      false,
    );
  });

  it('refuses other types and the implicit user topic', () => {
    expect(ClientMessage.safeParse({ type: 'ping' }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'sub', topics: ['user'] }).success).toBe(false);
  });
});

describe('ServerMessage', () => {
  it.each([
    { type: 'hello', instanceId: 'api-1-a1b2c3', serverTime: 1_791_000_000_000 },
    {
      type: 'snapshot',
      topic: `stock:${DROP}`,
      gen: 3,
      seq: 0,
      data: { avail: 10, held: 0, sold: 0, status: 'LIVE' },
    },
    { type: 'delta', topic: `room:${ROOM}`, gen: 0, seq: 1_791_000_000_001, ts: 1_791_000_000_001, data: {} },
    { type: 'order', orderId: JOB, status: 'PAID', version: 3 },
    { type: 'listing', jobId: JOB, status: 'READY' },
    { type: 'error', code: 'FORBIDDEN', topics: [`dash:${DROP}`] },
    { type: 'error', code: 'NOT_FOUND', topics: [`stock:${DROP}`] },
    { type: 'beat', serverTime: 1_791_000_000_000 },
  ])('round-trips $type', (message) => {
    expect(ServerMessage.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it('refuses a delta without its propagation timestamp', () => {
    expect(
      ServerMessage.safeParse({ type: 'delta', topic: `stock:${DROP}`, gen: 0, seq: 1, data: {} }).success,
    ).toBe(false);
  });
});

describe('frame data and channel payloads', () => {
  it('stock data is a level without its version', () => {
    expect(StockFrameData.parse({ avail: 1, held: 2, sold: 3, status: 'RECONCILING' })).toEqual({
      avail: 1,
      held: 2,
      sold: 3,
      status: 'RECONCILING',
    });
  });

  it('room data has a nullable pinned drop', () => {
    expect(RoomFrameData.parse({ pinned: null, viewers: 0 })).toEqual({ pinned: null, viewers: 0 });
    expect(RoomFrameData.safeParse({ pinned: { dropId: DROP, status: 'DRAFT' }, viewers: 1 }).success).toBe(
      false,
    );
  });

  it('user events are order or listing messages', () => {
    expect(UserEventMessage.parse({ type: 'listing', jobId: JOB, status: 'NEEDS_REVIEW' }).type).toBe(
      'listing',
    );
    expect(UserEventMessage.safeParse({ type: 'hello', instanceId: 'x', serverTime: 0 }).success).toBe(false);
  });

  it('room nudges name a public drop status', () => {
    expect(RoomChangedMessage.safeParse({ type: 'drop', dropId: DROP, status: 'LIVE' }).success).toBe(true);
    expect(RoomChangedMessage.safeParse({ type: 'drop', dropId: DROP, status: 'DRAFT' }).success).toBe(false);
  });
});
