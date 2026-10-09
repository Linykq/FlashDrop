import { BugError } from '@flashdrop/domain';

/*
 * Cross-instance fan-out (design §7): each gateway holds ONE Redis subscriber connection with a reference
 * count per channel. It SUBSCRIBEs for the first local holder of a channel and UNSUBSCRIBEs after the last
 * one leaves, so Redis delivers each publish once per interested instance, whatever the number of sockets.
 */

export type ChannelListener = (message: string, channel: string) => void;

/** The subscriber connection, as node-redis's `subscribe`/`unsubscribe` with a listener. */
export interface PubSub {
  subscribe(channel: string, listener: ChannelListener): Promise<void>;
  /** Removes exactly this listener; node-redis sends UNSUBSCRIBE once a channel has none left (spike §1.4). */
  unsubscribe(channel: string, listener: ChannelListener): Promise<void>;
}

export interface ChannelRegistry {
  /**
   * Takes one reference on the channel. Resolves once Redis has confirmed the subscription, so a snapshot
   * read after it cannot miss a publish (subscribe-then-snapshot, §7). Rejects if the SUBSCRIBE failed; the
   * reference is still taken and must be released.
   */
  acquire(channel: string): Promise<void>;
  /** Gives one reference back; the last one unsubscribes. */
  release(channel: string): void;
}

interface Entry {
  refs: number;
  /** What Redis holds, as far as completed commands tell. */
  subscribed: boolean;
  /** The tail of this channel's command chain; never rejects. */
  tail: Promise<void>;
  /** Steps queued on `tail` and not finished yet. */
  pending: number;
}

export interface ChannelRegistryOptions {
  readonly pubsub: PubSub;
  readonly onMessage: ChannelListener;
  readonly onError: (err: unknown, channel: string) => void;
}

export function createChannelRegistry(options: ChannelRegistryOptions): ChannelRegistry {
  const { pubsub, onMessage, onError } = options;
  const entries = new Map<string, Entry>();
  // One listener for every channel: node-redis keeps a set per channel, and unsubscribe must remove the same
  // function it was given.
  const listener: ChannelListener = (message, channel) => onMessage(message, channel);

  /*
   * Brings Redis in line with the reference count. Steps of one channel run one after another: with two in
   * flight, an UNSUBSCRIBE queued behind a later SUBSCRIBE (release then acquire in quick succession) would
   * leave the channel unsubscribed while it has holders. Each step reads the count when it runs, so a burst
   * of joins and leaves costs at most one command per step and always ends in the last state asked for.
   */
  function settle(channel: string, entry: Entry): Promise<void> {
    entry.pending += 1;
    const step = entry.tail.then(async () => {
      if (entry.refs > 0 && !entry.subscribed) {
        await pubsub.subscribe(channel, listener);
        entry.subscribed = true;
      } else if (entry.refs === 0 && entry.subscribed) {
        await pubsub.unsubscribe(channel, listener);
        entry.subscribed = false;
      }
    });
    entry.tail = step
      .catch(() => undefined)
      .finally(() => {
        entry.pending -= 1;
        if (entry.pending === 0 && entry.refs === 0 && !entry.subscribed) entries.delete(channel);
      });
    return step;
  }

  return {
    acquire(channel) {
      let entry = entries.get(channel);
      if (entry === undefined) {
        entry = { refs: 0, subscribed: false, tail: Promise.resolve(), pending: 0 };
        entries.set(channel, entry);
      }
      entry.refs += 1;
      return settle(channel, entry);
    },
    release(channel) {
      const entry = entries.get(channel);
      if (entry === undefined || entry.refs === 0)
        throw new BugError(`released ${channel} more than acquired`);
      entry.refs -= 1;
      if (entry.refs === 0) settle(channel, entry).catch((err: unknown) => onError(err, channel));
    },
  };
}
