import type {
  ClientMessage,
  HelloMessage,
  ListingStatusMessage,
  OrderStatusMessage,
  PinnedDrop,
  RoomFrameData,
  ServerMessage,
  StockFrameData,
  StockStatus,
  Topic,
  TopicErrorMessage,
  TopicKind,
  WS_PATH,
} from '@flashdrop/contracts';
import { LISTING_JOB_STATUSES, ORDER_STATUSES, PUBLIC_DROP_STATUSES } from '@flashdrop/domain';

/*
 * The browser's side of the real-time protocol (SD §7; the contract is `realtime.ts` in packages/contracts).
 * Frames are checked with type guards rather than the Zod contracts, like every other browser read in this
 * app (`reserve.ts`, `order-requests.ts`): the contracts would add about 90 KB gzipped to every live page
 * (design-system §14). The guards are typed against the contract's types, and `protocol.test.ts` runs the
 * same frames through both, so the Zod contract stays the source of truth and the two cannot drift apart.
 */

/** Same-origin path of the gateway (`WS_PATH`). */
export const GATEWAY_PATH: typeof WS_PATH = '/ws';

const TOPIC_KINDS: readonly string[] = ['stock', 'room', 'dash'] satisfies readonly TopicKind[];
const STOCK_STATUSES: readonly string[] = [
  ...PUBLIC_DROP_STATUSES,
  'RECONCILING',
] satisfies readonly StockStatus[];
const TOPIC_ERRORS: readonly string[] = [
  'FORBIDDEN',
  'TOO_MANY_TOPICS',
] satisfies readonly TopicErrorMessage['code'][];

/** RFC 9562 as Zod's `z.uuid()` accepts it. */
const UUID =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
/** A topic's id is a uuid as Postgres renders it, lowercase, so one drop never has two spellings. */
const TOPIC = /^(stock|room|dash):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The topic of a drop's stock, a room or a dashboard; ids are lowercased as the gateway requires. */
export function topicOf(kind: TopicKind, id: string): Topic {
  return `${kind}:${id.toLowerCase()}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number): value is number =>
  Number.isInteger(value) && Number(value) >= min;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isOneOf = <T extends string>(value: unknown, values: readonly string[]): value is T =>
  typeof value === 'string' && values.includes(value);
export const isTopic = (value: unknown): value is Topic => typeof value === 'string' && TOPIC.test(value);

/** The kind of a topic `isTopic` accepted. */
export function kindOf(topic: Topic): TopicKind {
  const kind = topic.slice(0, topic.indexOf(':'));
  if (!TOPIC_KINDS.includes(kind)) throw new TypeError(`not a topic: ${topic}`);
  return kind as TopicKind;
}

/** A level's version, compared lexicographically (SD §7). */
export type Version = { gen: number; seq: number };

/** Whether `next` is strictly newer than `current`. */
export function isNewer(next: Version, current: Version): boolean {
  return next.gen > current.gen || (next.gen === current.gen && next.seq > current.seq);
}

function hello(value: Record<string, unknown>): HelloMessage | null {
  const { instanceId, serverTime } = value;
  if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > 64) return null;
  if (!isInt(serverTime, 0)) return null;
  return { type: 'hello', instanceId, serverTime };
}

function level(value: Record<string, unknown>): (Version & { topic: Topic }) | null {
  const { topic, gen, seq } = value;
  if (!isTopic(topic) || !isInt(gen, -1) || !isInt(seq, 0)) return null;
  return { topic, gen, seq };
}

function order(value: Record<string, unknown>): OrderStatusMessage | null {
  const { orderId, status, version } = value;
  if (!isUuid(orderId) || !isOneOf<OrderStatusMessage['status']>(status, ORDER_STATUSES)) return null;
  return isInt(version, 1) ? { type: 'order', orderId, status, version } : null;
}

function listing(value: Record<string, unknown>): ListingStatusMessage | null {
  const { jobId, status } = value;
  if (!isUuid(jobId) || !isOneOf<ListingStatusMessage['status']>(status, LISTING_JOB_STATUSES)) return null;
  return { type: 'listing', jobId, status };
}

function topicError(value: Record<string, unknown>): TopicErrorMessage | null {
  const { code, topics } = value;
  if (!isOneOf<TopicErrorMessage['code']>(code, TOPIC_ERRORS) || !Array.isArray(topics)) return null;
  if (topics.length === 0 || !topics.every(isTopic)) return null;
  return { type: 'error', code, topics };
}

/** A frame from the gateway, or `null` for anything the contract's `ServerMessage` would refuse. */
export function parseServerMessage(text: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'hello':
      return hello(value);
    case 'snapshot': {
      const head = level(value);
      return head && { type: 'snapshot', ...head, data: value.data };
    }
    case 'delta': {
      const head = level(value);
      return head && isInt(value.ts, 0) ? { type: 'delta', ...head, ts: value.ts, data: value.data } : null;
    }
    case 'order':
      return order(value);
    case 'listing':
      return listing(value);
    case 'error':
      return topicError(value);
    default:
      return null;
  }
}

/** `data` of a `stock:` frame (`StockFrameData`), or `null`. */
export function parseStockData(data: unknown): StockFrameData | null {
  if (!isRecord(data)) return null;
  const { avail, held, sold, status } = data;
  if (!isInt(avail, 0) || !isInt(held, 0) || !isInt(sold, 0)) return null;
  return isOneOf<StockStatus>(status, STOCK_STATUSES) ? { avail, held, sold, status } : null;
}

function pinnedDrop(value: unknown): PinnedDrop | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isUuid(value.dropId)) return undefined;
  const { status } = value;
  return isOneOf<PinnedDrop['status']>(status, PUBLIC_DROP_STATUSES)
    ? { dropId: value.dropId, status }
    : undefined;
}

/** `data` of a `room:` frame (`RoomFrameData`), or `null`. */
export function parseRoomData(data: unknown): RoomFrameData | null {
  if (!isRecord(data) || !isInt(data.viewers, 0)) return null;
  const pinned = pinnedDrop(data.pinned);
  return pinned === undefined ? null : { pinned, viewers: data.viewers };
}

/** A client frame, serialized. */
export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}
