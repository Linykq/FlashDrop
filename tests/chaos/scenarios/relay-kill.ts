import { compose, killService, outboxInFlight, startServices, until } from '../../../tools/system/support';
import { containersOf, unpauseIfPaused } from '../docker';
import type { Scenario } from '../harness';
import { deliveryOf, deliveryProblems } from './delivery';

/*
 * `relay-kill` (design §13 core chaos case, §5.4 "crash after send, before mark"): the worker is SIGKILLed
 * while a relay batch is in flight under the burst. To catch a batch in flight rather than between batches
 * (a healthy send takes milliseconds), the broker is paused: the relay's send then waits for
 * acknowledgements (up to message.timeout.ms, 10 s) while its transaction holds the batch's rows and the
 * relay fence, the first such batch times out and rolls back, and the next one takes the backlog the burst
 * piled up meanwhile. The worker dies with that batch locked, Postgres ends its session (rows and fence
 * free again), Kafka resumes and may append whatever the dead producer had already sent, and the restarted
 * relay publishes the rows again. Consumers dedupe the copies, so every order ends as if nothing happened.
 * Checkout never needs the relay: the burst runs on while the worker is dead.
 */

/** Rows of the in-flight batch at the kill: the backlog, not the one or two rows of a poll. */
const BACKLOG_ROWS = 20;

export const relayKill: Scenario = {
  name: 'relay-kill',
  fault:
    'SIGKILL the worker while a relay batch is in flight (broker paused so the batch is caught mid-send)',
  async inject(ctx) {
    await compose(['pause', 'kafka']);
    ctx.log('kafka paused: relay sends wait for acknowledgements that cannot come');
    let caught: { pending: number; locked: number };
    let deadAt: number;
    try {
      caught = await until(
        'a relay batch of the backlog in flight',
        () => outboxInFlight(ctx.stores.pool),
        (outbox) => outbox.locked >= BACKLOG_ROWS,
        60_000,
      );
      await killService('worker');
      deadAt = Date.now();
      ctx.log(
        `SIGKILL worker with a batch of ${caught.locked} rows in flight (${caught.pending} unpublished)`,
      );
      await until(
        'Postgres ending the dead relay session',
        () => outboxInFlight(ctx.stores.pool),
        (outbox) => outbox.locked === 0,
        30_000,
      );
    } finally {
      await compose(['unpause', 'kafka']);
    }
    const [worker] = await containersOf('worker');
    await startServices('worker');
    ctx.log(`worker back after ${((Date.now() - deadAt) / 1000).toFixed(1)} s`);
    ctx.record('relayKill', {
      lockedAtKill: caught.locked,
      unpublishedAtKill: caught.pending,
      workerExitCode: worker?.exitCode,
      deadForMs: Date.now() - deadAt,
    });
  },
  async verify(ctx, burst) {
    const delivery = await deliveryOf(ctx, [...burst.orders.keys()]);
    const { missing, unknown, ...counts } = delivery;
    ctx.record('delivery', { ...counts, missing: missing.length, unknown: unknown.length });
    ctx.log(
      `delivery: ${delivery.events} events, ${delivery.records} records, copies ${JSON.stringify(delivery.copies)}`,
    );
    return deliveryProblems(delivery, 1);
  },
  async restore() {
    await unpauseIfPaused('kafka');
    await startServices('worker');
  },
};
