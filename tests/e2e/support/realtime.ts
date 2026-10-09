import {
  type DeltaMessage,
  ServerMessage,
  type SnapshotMessage,
  StockFrameData,
  type Topic,
  topicOf,
} from '@flashdrop/contracts';
import { expect, type Page } from '@playwright/test';

/*
 * What a page's realtime client gets from the gateway (design §7), recorded from the browser's own sockets:
 * every frame parsed with the contract, so a spec can assert on the protocol (which instance answered, which
 * snapshot or delta carried a level) as well as on what the page shows. Start recording before `page.goto`.
 */

/** `/ws`, and `/ws/1` or `/ws/2` for a page pinned with `?ws=` (Caddy, §7). */
const GATEWAY_PATH = /^\/ws(\/\d+)?$/;

export interface ReceivedFrame {
  /** `Date.now()` in the test process when Playwright reported the frame. */
  readonly at: number;
  readonly message: ServerMessage;
}

export interface GatewaySocket {
  /** `/ws`, `/ws/1` or `/ws/2`. */
  readonly path: string;
  readonly frames: ReceivedFrame[];
  closed: boolean;
}

export interface GatewayRecording {
  /** Every gateway socket the page opened, in order. */
  readonly sockets: readonly GatewaySocket[];
  /** Frames that were not JSON or failed `ServerMessage`; a spec expects none. */
  readonly malformed: readonly string[];
}

export function recordGateway(page: Page): GatewayRecording {
  const sockets: GatewaySocket[] = [];
  const malformed: string[] = [];
  page.on('websocket', (ws) => {
    const path = new URL(ws.url()).pathname;
    if (!GATEWAY_PATH.test(path)) return;
    const socket: GatewaySocket = { path, frames: [], closed: false };
    sockets.push(socket);
    ws.on('framereceived', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString('utf8');
      const parsed = ServerMessage.safeParse(parseJson(text));
      if (parsed.success) socket.frames.push({ at: Date.now(), message: parsed.data });
      else malformed.push(text);
    });
    ws.on('close', () => {
      socket.closed = true;
    });
  });
  return { sockets, malformed };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The `hello.instanceId` of every socket that has received its hello, in the order they opened. */
export function instanceIds(recording: GatewayRecording): string[] {
  return recording.sockets.flatMap((socket) => {
    const hello = socket.frames.find((frame) => frame.message.type === 'hello');
    return hello?.message.type === 'hello' ? [hello.message.instanceId] : [];
  });
}

export type LevelFrame = (SnapshotMessage | DeltaMessage) & {
  readonly at: number;
  /** Index of the socket in `recording.sockets`. */
  readonly socket: number;
};

/** Every snapshot and delta received on `topic`, across the page's sockets, in arrival order. */
export function levelFrames(recording: GatewayRecording, topic: Topic): LevelFrame[] {
  return recording.sockets
    .flatMap((socket, index) =>
      socket.frames.flatMap(({ at, message }) =>
        (message.type === 'snapshot' || message.type === 'delta') && message.topic === topic
          ? [{ ...message, at, socket: index }]
          : [],
      ),
    )
    .sort((a, b) => a.at - b.at);
}

/** Whether every frame's `(gen, seq)` is strictly newer than the one before it (§7 step 2). */
export function strictlyNewer(frames: readonly Pick<LevelFrame, 'gen' | 'seq'>[]): boolean {
  return frames.every((frame, i) => {
    const previous = frames[i - 1];
    return (
      previous === undefined ||
      frame.gen > previous.gen ||
      (frame.gen === previous.gen && frame.seq > previous.seq)
    );
  });
}

/** The design's bound on stock propagation to a viewer (§1, §13), judged on the frames a page received. */
export const PROPAGATES_WITHIN_MS = 1_000;

/**
 * How long a page may take to show a level its socket already received: React's render and Playwright's
 * polling, which on a CI runner share 4 vCPUs with the whole stack and a second test worker. Locally the
 * design's own bound applies to the DOM too.
 */
export const SHOWN_WITHIN_MS = process.env.CI ? 5_000 : PROPAGATES_WITHIN_MS;

/**
 * Asserts that `recording` received the drop's level with `avail` within PROPAGATES_WITHIN_MS of `since`,
 * `Date.now()` when the change it reflects was answered. The frame may even come first: the Function
 * publishes before the api answers. Levels are told apart by `avail`, so a spec's levels must not repeat.
 */
export async function expectPropagated(
  recording: GatewayRecording,
  dropId: string,
  avail: number,
  since: number,
): Promise<void> {
  const arrival = () => stockFrames(recording, dropId).find((frame) => frame.data.avail === avail)?.at;
  await expect
    .poll(arrival, { message: `a stock frame with avail ${avail} arrives`, timeout: SHOWN_WITHIN_MS })
    .toBeDefined();
  expect(
    (arrival() ?? Number.POSITIVE_INFINITY) - since,
    `ms from the answer to the frame with avail ${avail}`,
  ).toBeLessThanOrEqual(PROPAGATES_WITHIN_MS);
}

export type StockFrame = LevelFrame & { readonly data: StockFrameData };

/** The drop's stock levels the page received, parsed with `StockFrameData`. */
export function stockFrames(recording: GatewayRecording, dropId: string): StockFrame[] {
  return levelFrames(recording, topicOf('stock', dropId)).map((frame) => ({
    ...frame,
    data: StockFrameData.parse(frame.data),
  }));
}
