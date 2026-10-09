import { delimiter } from 'node:path';
import { z } from 'zod';
import { compose, until } from '../../../tools/system/support';
import { containersOf, logsSince } from '../docker';
import type { Scenario } from '../harness';
import { deliveryOf, deliveryProblems } from './delivery';

/*
 * `dup-delivery` (design §13 stretch chaos case, §6.4 "consumers dedupe"): the relay publishes every batch
 * twice for the whole burst, so each consumer group is sent every event at least twice, sometimes both
 * copies in one batch, sometimes in two. The payment group must still charge once per order (PSP key and
 * orders CAS), settlement must apply each outcome once (Lua NOOP), and the dashboard must count each event
 * once (`processed_events`): INV-4, INV-6 and INV-5's dashboard totals.
 *
 * The mode is the worker's test-only `FD_CHAOS_DUP_DELIVERY`, which only ./compose.dup-delivery.yaml sets.
 * Before using it, the run shows that the stack's own configuration cannot enable it: even with the
 * variable exported in the environment that interpolates compose.yaml, the worker would not get it.
 */

const VARIABLE = 'FD_CHAOS_DUP_DELIVERY';
const OVERLAY = 'tests/chaos/compose.dup-delivery.yaml';
const ON_LOG = 'FD_CHAOS_DUP_DELIVERY is on: every outbox batch is published twice (chaos test mode)';

const WorkerConfig = z.object({
  services: z.object({ worker: z.object({ environment: z.record(z.string(), z.string().nullable()) }) }),
});

let dupOn = false;
let startedAt = 0;

/** Re-creates the worker, from the stack's files plus `extraFiles`, and waits until it is healthy. */
async function recreateWorker(extraFiles: readonly string[]): Promise<void> {
  const files = [process.env.COMPOSE_FILE ?? '', ...extraFiles].join(delimiter);
  await compose(
    ['up', '--detach', '--wait', '--wait-timeout', '180', '--no-deps', '--force-recreate', 'worker'],
    {
      COMPOSE_FILE: files,
    },
  );
}

export const dupDelivery: Scenario = {
  name: 'dup-delivery',
  fault: 'the relay publishes every outbox batch twice for the whole burst (FD_CHAOS_DUP_DELIVERY)',
  async prepare(ctx) {
    const config = WorkerConfig.parse(
      JSON.parse(await compose(['config', '--format', 'json', 'worker'], { [VARIABLE]: 'true' })),
    );
    if (VARIABLE in config.services.worker.environment) {
      throw new Error(`the stack's own configuration passes ${VARIABLE} to the worker`);
    }
    ctx.record('defaultConfigCannotEnable', `${VARIABLE}=true in the environment: not in the worker's`);

    await ctx.checkpoint('before the worker is re-created');
    dupOn = true;
    startedAt = Date.now();
    await recreateWorker([OVERLAY]);
    const [worker] = await containersOf('worker');
    if (worker === undefined) throw new Error('no worker container');
    await until(
      'the worker announcing the dup-delivery mode',
      async () => (await logsSince(worker.id, new Date(startedAt))).some((line) => line.msg === ON_LOG),
      (on) => on,
      30_000,
    );
    ctx.log(`worker re-created with ${VARIABLE}=true: every batch goes out twice`);
  },
  async inject(ctx) {
    ctx.log('the fault is on for the whole burst; nothing more to inject');
  },
  async verify(ctx, burst) {
    const delivery = await deliveryOf(ctx, [...burst.orders.keys()]);
    const { missing, unknown, ...counts } = delivery;
    ctx.record('delivery', { ...counts, missing: missing.length, unknown: unknown.length });
    ctx.log(
      `delivery: ${delivery.events} events, ${delivery.records} records, copies ${JSON.stringify(delivery.copies)}`,
    );
    return deliveryProblems(delivery, 2);
  },
  async restore() {
    if (!dupOn) return;
    const since = new Date();
    await recreateWorker([]);
    const [worker] = await containersOf('worker');
    if (worker === undefined) throw new Error('no worker container');
    if ((await logsSince(worker.id, since)).some((line) => line.msg === ON_LOG)) {
      throw new Error(`the re-created worker still runs with ${VARIABLE}`);
    }
    dupOn = false;
  },
};
