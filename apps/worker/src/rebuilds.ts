import type { Logger } from '@flashdrop/config';
import type { SyncOutcome } from '@flashdrop/inventory';
import { countRebuild, type RebuildReason } from './metrics';

/**
 * The one place a worker rebuild is counted (`fd_rebuilds_total{reason}`, §12) and logged, so every caller
 * (the reconciler's triggers, the orphan scan) labels it the same way. Only a rebuild that happened counts:
 * STALE is a zombie sync that lost to a newer generation, and UNKNOWN_DROP or NOT_ARMED a drop that left
 * the tracked set.
 */
export function reportRebuild(
  log: Pick<Logger, 'info' | 'warn'>,
  reason: RebuildReason,
  outcome: SyncOutcome,
): void {
  if (outcome.kind === 'REBUILT') {
    countRebuild(reason);
    log.info({ reason, gen: outcome.gen, status: outcome.status, orders: outcome.orders }, 'drop rebuilt');
  } else {
    log.warn({ reason, outcome: outcome.kind }, 'drop not rebuilt');
  }
}
