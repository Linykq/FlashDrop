import { BugError } from '@flashdrop/domain';
import { describe, expect, it, vi } from 'vitest';
import { type ChannelListener, createChannelRegistry, type PubSub } from './channels';

/** A subscriber whose SUBSCRIBEs can be held open, recording the commands it was sent. */
function fakePubSub() {
  const commands: string[] = [];
  const listeners = new Map<string, ChannelListener>();
  let hold: Promise<void> | undefined;
  let open = () => {};
  let failNext = false;
  const pubsub: PubSub = {
    async subscribe(channel, listener) {
      commands.push(`SUBSCRIBE ${channel}`);
      if (failNext) {
        failNext = false;
        throw new Error('subscriber closed');
      }
      await hold;
      listeners.set(channel, listener);
    },
    async unsubscribe(channel) {
      commands.push(`UNSUBSCRIBE ${channel}`);
      listeners.delete(channel);
    },
  };
  return {
    pubsub,
    commands,
    listeners,
    holdSubscribes() {
      hold = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      open();
      hold = undefined;
    },
    failNextSubscribe() {
      failNext = true;
    },
  };
}

function setup() {
  const fake = fakePubSub();
  const messages: [string, string][] = [];
  const onError = vi.fn();
  const registry = createChannelRegistry({
    pubsub: fake.pubsub,
    onMessage: (message, channel) => messages.push([channel, message]),
    onError,
  });
  return { ...fake, registry, messages, onError };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createChannelRegistry (§7 reference-counted fan-out)', () => {
  it('subscribes once for many holders and unsubscribes after the last one leaves', async () => {
    const { registry, commands } = setup();
    await Promise.all([registry.acquire('ch:a'), registry.acquire('ch:a'), registry.acquire('ch:a')]);
    expect(commands).toEqual(['SUBSCRIBE ch:a']);

    registry.release('ch:a');
    registry.release('ch:a');
    await flush();
    expect(commands).toEqual(['SUBSCRIBE ch:a']);

    registry.release('ch:a');
    await flush();
    expect(commands).toEqual(['SUBSCRIBE ch:a', 'UNSUBSCRIBE ch:a']);
  });

  it('resolves acquire only once Redis confirmed the subscription, for every holder', async () => {
    const { registry, holdSubscribes, release } = setup();
    holdSubscribes();
    const order: string[] = [];
    const first = registry.acquire('ch:a').then(() => order.push('first'));
    const second = registry.acquire('ch:a').then(() => order.push('second'));
    await flush();
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('ends subscribed when a leave and a join race a pending SUBSCRIBE', async () => {
    const { registry, commands, listeners, holdSubscribes, release } = setup();
    holdSubscribes();
    const first = registry.acquire('ch:a');
    registry.release('ch:a');
    const again = registry.acquire('ch:a');
    release();
    await Promise.all([first, again]);
    await flush();
    // Serialized and read when each step runs: the UNSUBSCRIBE never overtakes the SUBSCRIBE it undoes.
    expect(commands).toEqual(['SUBSCRIBE ch:a']);
    expect(listeners.has('ch:a')).toBe(true);
  });

  it('routes every channel through the one listener', async () => {
    const { registry, listeners, messages } = setup();
    await registry.acquire('ch:a');
    await registry.acquire('ch:b');
    listeners.get('ch:a')?.('one', 'ch:a');
    listeners.get('ch:b')?.('two', 'ch:b');
    expect(messages).toEqual([
      ['ch:a', 'one'],
      ['ch:b', 'two'],
    ]);
    expect(listeners.get('ch:a')).toBe(listeners.get('ch:b'));
  });

  it('rejects acquire when SUBSCRIBE fails, and the next acquire tries again', async () => {
    const { registry, commands, failNextSubscribe } = setup();
    failNextSubscribe();
    await expect(registry.acquire('ch:a')).rejects.toThrow('subscriber closed');
    registry.release('ch:a');
    await flush();

    await registry.acquire('ch:a');
    expect(commands).toEqual(['SUBSCRIBE ch:a', 'SUBSCRIBE ch:a']);
  });

  it('refuses a release without an acquire', () => {
    const { registry } = setup();
    expect(() => registry.release('ch:a')).toThrow(BugError);
  });
});
