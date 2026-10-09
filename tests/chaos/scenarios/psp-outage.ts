import { setTimeout as sleep } from 'node:timers/promises';
import { CONSUMER_GROUPS } from '../../../tools/system/chaos-support';
import { groupLagOn, recreatePaymentMock, until } from '../../../tools/system/support';
import { containersOf, logsSince } from '../docker';
import type { Scenario } from '../harness';

/*
 * `psp-outage` (design §13 stretch chaos case, §6.4 transient failures, §17 "PSP timeout"): payment-mock
 * answers 503 to every charge and close for 60 s, longer than the consumer runner's 30 s backoff cap, so
 * the sale's partition is paused, sought back and resumed through several retries, the last ones at the cap.
 * A transient failure is retried indefinitely and never dead-lettered; no charge is recorded while the PSP
 * fails (a 503 records nothing). When the PSP is back, the partition resumes from its first unfinished
 * offset, and every `pm_ok` order is paid exactly once, well inside its 300 s payment window.
 */

const OUTAGE_MS = 60_000;
const LAG_SAMPLE_MS = 5_000;
/** The runner's transient backoff: 100 ms doubling up to 30 s, full jitter (§6.4). */
const BACKOFF_CAP_MS = 30_000;

let outageOn = false;
let outage: { readonly from: number; readonly to: number } | undefined;

export const pspOutage: Scenario = {
  name: 'psp-outage',
  fault: 'payment-mock answers 503 to every charge and close for 60 s, longer than the 30 s backoff cap',
  load: { buyers: 1400, stock: 800, faultAt: 0.25 },
  async inject(ctx) {
    outageOn = true;
    await recreatePaymentMock({ PSP_ERROR_RATE: '1' });
    const from = Date.now();
    ctx.log('payment-mock re-created with PSP_ERROR_RATE=1: every charge and close answers 503');
    const lag: { atS: number; lag: number }[] = [];
    while (Date.now() - from < OUTAGE_MS) {
      lag.push({
        atS: Math.round((Date.now() - from) / 1000),
        lag: await groupLagOn(ctx.stores, CONSUMER_GROUPS.payment, ctx.partition),
      });
      await sleep(Math.max(0, from + lag.length * LAG_SAMPLE_MS - Date.now()));
    }
    // Its replacement takes the outage container's restart count with it.
    await ctx.checkpoint('end of the PSP outage');
    await recreatePaymentMock();
    outageOn = false;
    outage = { from, to: Date.now() };
    ctx.log(`payment-mock back to the stack's settings after ${((outage.to - from) / 1000).toFixed(1)} s`);
    // The partition resumes when its pending backoff runs out (at most the 30 s cap), then drains the backlog.
    await until(
      `the payment group draining partition ${ctx.partition}`,
      () => groupLagOn(ctx.stores, CONSUMER_GROUPS.payment, ctx.partition),
      (n) => n === 0,
      240_000,
    );
    const drainedAfterMs = Date.now() - outage.to;
    ctx.log(
      `payment partition ${ctx.partition} caught up ${(drainedAfterMs / 1000).toFixed(1)} s after the outage`,
    );
    ctx.record('paymentLag', {
      duringOutage: lag,
      peak: Math.max(0, ...lag.map((s) => s.lag)),
      drainedAfterMs,
    });
  },
  async verify(ctx) {
    if (outage === undefined) return ['the fault was never injected'];
    const { from, to } = outage;
    const pauses = [];
    for (const replica of await containersOf('consumers')) {
      for (const line of await logsSince(replica.id, new Date(from))) {
        if (
          line.msg === 'partition paused for a retry' &&
          line.consumer === 'payment' &&
          line.partition === ctx.partition
        ) {
          pauses.push({
            at: Date.parse(line.time),
            retries: Number(line.retries),
            retryInMs: Number(line.retryInMs),
          });
        }
      }
    }
    const during = pauses.filter((p) => p.at <= to);
    const maxRetries = Math.max(0, ...during.map((p) => p.retries));
    // The ceiling of the jittered delay at that retry: 100 ms * 2^(n-1), capped.
    const ceilingMs = Math.min(BACKOFF_CAP_MS, 100 * 2 ** Math.max(0, maxRetries - 1));
    ctx.record('paymentPartitionPauses', {
      duringOutage: during.length,
      // While the backlog drains: the 1% of charges whose answer payment-mock withholds time out (§6.5).
      afterOutage: pauses.length - during.length,
      maxConsecutiveRetries: maxRetries,
      backoffCeilingReachedMs: ceilingMs,
      longestDelayMs: Math.max(0, ...during.map((p) => p.retryInMs)),
    });
    ctx.log(
      `payment partition ${ctx.partition}: paused ${during.length} times during the outage, up to ${maxRetries} ` +
        `retries in a row (backoff ceiling ${ceilingMs / 1000} s)`,
    );
    const problems: string[] = [];
    if (during.length < 3)
      problems.push(`the payment partition paused ${during.length} times during the outage`);
    if (ceilingMs < BACKOFF_CAP_MS) {
      problems.push(
        `the backoff never reached its ${BACKOFF_CAP_MS / 1000} s cap (at most ${maxRetries} retries)`,
      );
    }
    return problems;
  },
  async restore() {
    if (!outageOn) return;
    await recreatePaymentMock();
    outageOn = false;
  },
};
