import { RoomFrameData, ServerMessage, StockFrameData } from '@flashdrop/contracts';
import { describe, expect, it } from 'vitest';
import { isNewer, parseRoomData, parseServerMessage, parseStockData, topicOf } from './protocol';

const DROP = '5eed0004-0000-4000-8000-000000000001';
const ROOM = '5eed0002-0000-4000-8000-000000000001';
const ORDER = '0192a9c2-7c1e-7d3a-8f00-3b4c5d6e7f80';

/** What the Zod contract makes of a frame: the parsed message, or `null` where it refuses it. */
function contract(frame: unknown): unknown {
  const parsed = ServerMessage.safeParse(frame);
  return parsed.success ? parsed.data : null;
}

const valid: Record<string, unknown> = {
  hello: { type: 'hello', instanceId: 'api-1-3fa2c1', serverTime: 1_791_000_000_000 },
  'stock snapshot': {
    type: 'snapshot',
    topic: `stock:${DROP}`,
    gen: 2,
    seq: 41,
    data: { avail: 12, held: 3, sold: 485, status: 'LIVE' },
  },
  'fail-closed snapshot': {
    type: 'snapshot',
    topic: `stock:${DROP}`,
    gen: -1,
    seq: 0,
    data: { avail: 0, held: 0, sold: 0, status: 'RECONCILING' },
  },
  'room delta': {
    type: 'delta',
    topic: `room:${ROOM}`,
    gen: 0,
    seq: 1_791_000_000_123,
    ts: 1_791_000_000_123,
    data: { pinned: { dropId: DROP, status: 'LIVE' }, viewers: 3 },
  },
  'dash delta': {
    type: 'delta',
    topic: `dash:${DROP}`,
    gen: 0,
    seq: 7,
    ts: 1_791_000_000_000,
    data: { unitsSold: 4 },
  },
  order: { type: 'order', orderId: ORDER, status: 'PAID', version: 3 },
  listing: { type: 'listing', jobId: ORDER, status: 'NEEDS_REVIEW' },
  'topic error': { type: 'error', code: 'FORBIDDEN', topics: [`dash:${DROP}`] },
  'extra keys': { type: 'hello', instanceId: 'api-2', serverTime: 0, extra: true },
};

const invalid: Record<string, unknown> = {
  'an unknown type': { type: 'pong' },
  'an array': [],
  'a string': 'hello',
  'an empty instance id': { type: 'hello', instanceId: '', serverTime: 1 },
  'a long instance id': { type: 'hello', instanceId: 'x'.repeat(65), serverTime: 1 },
  'a fractional server time': { type: 'hello', instanceId: 'api-1', serverTime: 1.5 },
  'an uppercase topic id': {
    type: 'snapshot',
    topic: `stock:${DROP.toUpperCase()}`,
    gen: 0,
    seq: 0,
    data: null,
  },
  'an unknown topic kind': { type: 'snapshot', topic: `user:${DROP}`, gen: 0, seq: 0, data: null },
  'a gen below -1': { type: 'snapshot', topic: `stock:${DROP}`, gen: -2, seq: 0, data: null },
  'a negative seq': { type: 'snapshot', topic: `stock:${DROP}`, gen: 0, seq: -1, data: null },
  'a delta without ts': { type: 'delta', topic: `stock:${DROP}`, gen: 0, seq: 1, data: null },
  'an order with version 0': { type: 'order', orderId: ORDER, status: 'PAID', version: 0 },
  'an order with an unknown status': { type: 'order', orderId: ORDER, status: 'SHIPPED', version: 1 },
  'an order id that is no uuid': { type: 'order', orderId: '42', status: 'PAID', version: 1 },
  'a listing with an unknown status': { type: 'listing', jobId: ORDER, status: 'DONE' },
  'an error without topics': { type: 'error', code: 'FORBIDDEN', topics: [] },
  'an unknown error code': { type: 'error', code: 'NOPE', topics: [`dash:${DROP}`] },
};

describe('parseServerMessage', () => {
  it.each(Object.entries(valid))('reads %s exactly as the contract does', (_name, frame) => {
    const parsed = parseServerMessage(JSON.stringify(frame));
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(contract(frame));
  });

  it.each(Object.entries(invalid))('refuses %s, as the contract does', (_name, frame) => {
    expect(contract(frame)).toBeNull();
    expect(parseServerMessage(JSON.stringify(frame))).toBeNull();
  });

  it('refuses text that is not JSON', () => {
    expect(parseServerMessage('{"type":')).toBeNull();
  });
});

describe('frame data', () => {
  it.each([
    [{ avail: 0, held: 2, sold: 8, status: 'PAUSED' }, true],
    [{ avail: 0, held: 0, sold: 0, status: 'RECONCILING' }, true],
    [{ avail: -1, held: 0, sold: 0, status: 'LIVE' }, false],
    [{ avail: 1, held: 0, sold: 0, status: 'DRAFT' }, false],
    [{ avail: 1, held: 0, status: 'LIVE' }, false],
    [null, false],
  ])('reads stock %j as the contract does', (data, ok) => {
    expect(StockFrameData.safeParse(data).success).toBe(ok);
    expect(parseStockData(data)).toEqual(ok ? StockFrameData.parse(data) : null);
  });

  it.each([
    [{ pinned: { dropId: DROP, status: 'SCHEDULED' }, viewers: 0 }, true],
    [{ pinned: null, viewers: 1_284 }, true],
    [{ pinned: { dropId: DROP, status: 'DRAFT' }, viewers: 1 }, false],
    [{ pinned: { dropId: 'x', status: 'LIVE' }, viewers: 1 }, false],
    [{ viewers: 1 }, false],
    [{ pinned: null, viewers: -1 }, false],
  ])('reads room %j as the contract does', (data, ok) => {
    expect(RoomFrameData.safeParse(data).success).toBe(ok);
    expect(parseRoomData(data)).toEqual(ok ? RoomFrameData.parse(data) : null);
  });
});

describe('topics and versions', () => {
  it('lowercases topic ids, as the gateway requires', () => {
    expect(topicOf('stock', DROP.toUpperCase())).toBe(`stock:${DROP}`);
  });

  it('orders versions by gen, then seq, and keeps equal ones out', () => {
    expect(isNewer({ gen: 3, seq: 8 }, { gen: 3, seq: 7 })).toBe(true);
    expect(isNewer({ gen: 3, seq: 7 }, { gen: 3, seq: 7 })).toBe(false);
    expect(isNewer({ gen: 4, seq: 0 }, { gen: 3, seq: 9_000 })).toBe(true);
    expect(isNewer({ gen: 1, seq: 0 }, { gen: -1, seq: 0 })).toBe(true);
  });
});
