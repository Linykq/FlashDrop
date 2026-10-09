import type { Logger } from '@flashdrop/config';
import { alert } from '@flashdrop/domain';
import { type DriftSource, type DriftStreak, observeDrift, sampleDrift } from '@flashdrop/inventory';
import { clearDriftUnits, setDriftUnits } from './drift-gauge';

/*
 * The drift checks (design §4.7, every 10 s) over every tracked drop: one stable sample of each per round
 * (`sampleDrift`: four reads, each batched over the drops), folded into the drop's streak (`observeDrift`):
 *
 *   - Redis optimistic on two consecutive stable samples: ERROR alert `redis_drift`, rebuild (`drift`).
 *   - any difference, Σuq ≠ Σclaimed included, on three consecutive quiescent samples: rebuild (`leak`).
 *
 * Lower Redis promptly on evidence, raise it only when quiescent: a rebuild costs the drop a moment of 503s,
 * and the Postgres CHECK already makes a transient high reading safe, so a single sample never rebuilds.
 * Every stable sample sets `fd_redis_drift_units{drop}`.
 */

export type RebuildOutcome = 'rebuilt' | 'busy' | 'failed';

/** Rebuilds the drop under its lock unless another session holds it (`busy`). */
export type RebuildUnlessBusy = (
  dropId: string,
  reason: 'drift' | 'leak' | 'refusal',
  log: Logger,
) => Promise<RebuildOutcome>;

export interface DriftChecks {
  /** One round over `dropIds`, the tracked set. */
  run(dropIds: readonly string[], signal: AbortSignal): Promise<void>;
}

export function createDriftChecks(
  deps: { readonly source: DriftSource; readonly logger: Logger },
  rebuild: RebuildUnlessBusy,
): DriftChecks {
  const streaks = new Map<string, DriftStreak>();
  /** Drops with a value in the gauge, so that a drop leaving the tracked set leaves the series too. */
  const gauged = new Set<string>();

  return {
    async run(dropIds, signal) {
      const tracked = new Set(dropIds);
      for (const dropId of gauged) {
        if (tracked.has(dropId)) continue;
        clearDriftUnits(dropId);
        gauged.delete(dropId);
      }
      for (const dropId of streaks.keys()) if (!tracked.has(dropId)) streaks.delete(dropId);

      for (const sample of await sampleDrift(deps.source, dropIds)) {
        if (signal.aborted) return;
        const { dropId } = sample;
        // A partial `inv` is the structural check's to repair; a garbled `uq` only a rebuild repairs.
        if (sample.redis === 'MALFORMED') {
          deps.logger.warn({ dropId }, 'drift sample unreadable: malformed inv or uq hash');
        }

        const { streak, findings, verdict } = observeDrift(streaks.get(dropId), sample);
        if (streak === undefined) streaks.delete(dropId);
        else streaks.set(dropId, streak);
        if (findings === null) continue;
        setDriftUnits(dropId, findings.units);
        gauged.add(dropId);
        if (verdict === null) continue;

        const log = deps.logger.child({ dropId });
        const context = { driftUnits: findings.units, findings: findings.mismatch };
        if (verdict === 'drift') {
          alert(
            log,
            'redis_drift',
            context,
            'redis optimistic on two consecutive stable samples; rebuilding',
          );
        } else {
          log.warn(context, 'redis differs from postgres on three quiescent samples (a leak); rebuilding');
        }
        // Busy or failed: the streak stands, so the next stable sample of the drop tries again.
        if ((await rebuild(dropId, verdict, log)) === 'rebuilt') streaks.delete(dropId);
      }
    },
  };
}
