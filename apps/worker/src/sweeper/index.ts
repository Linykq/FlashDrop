import type { WorkerDeps } from '../deps';
import type { LoopSpec } from '../loop';
import { dropScheduler } from './drop-scheduler';
import { expireOrders } from './expire-orders';
import { createOrphanScan } from './orphan-scan';
import { settleSafetyNet } from './settle-safety-net';

/**
 * The `sweeper` role (design §4.6): Postgres-driven expiry, the settlement safety net, the orphan scan and
 * the drop scheduler. Each loop takes its own advisory lock per tick, so several workers can run the role;
 * one does the work and the others stand by.
 */
export function sweeperLoops(deps: WorkerDeps): LoopSpec[] {
  return [
    { name: 'expire-orders', everyMs: 1_000, tick: (signal) => expireOrders(deps, signal) },
    { name: 'settle-safety-net', everyMs: 5_000, tick: (signal) => settleSafetyNet(deps, signal) },
    { name: 'orphan-scan', everyMs: 5_000, tick: createOrphanScan(deps) },
    { name: 'drop-scheduler', everyMs: 1_000, tick: (signal) => dropScheduler(deps, signal) },
  ];
}
