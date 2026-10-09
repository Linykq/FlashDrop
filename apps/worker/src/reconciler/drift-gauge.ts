import { Gauge } from '@prometheus-io/client';
import { registry } from '../metrics';

/*
 * `fd_redis_drift_units{drop}` (design §12): Redis `avail` minus Postgres `total − sold − reserved` at the
 * drop's last stable sample (§4.7). Positive means Redis would admit units Postgres no longer has; negative
 * is normal while work is in flight. A drop leaves the series when it leaves the tracked set, so the series
 * count stays bounded by the tracked set (drops until 24 h after they end).
 */
const driftUnits = new Gauge({
  name: 'fd_redis_drift_units',
  help: 'Redis avail minus Postgres available at the last stable sample of a tracked drop; positive is optimistic (§4.7).',
  labelNames: ['drop'] as const,
  registers: [registry],
});

export function setDriftUnits(dropId: string, units: number): void {
  driftUnits.set({ drop: dropId }, units);
}

export function clearDriftUnits(dropId: string): void {
  driftUnits.remove({ drop: dropId });
}
