import { CircleCheck, CircleDashed, CircleX, type LucideIcon, TriangleAlert } from 'lucide-react';
import { type PillTone, StatusPill } from '../ui/status-pill';
import type { HealthLevel } from './health-model';

const PILLS: Readonly<Record<HealthLevel, { tone: PillTone; icon: LucideIcon; label: string }>> = {
  healthy: { tone: 'success', icon: CircleCheck, label: 'Healthy' },
  degraded: { tone: 'warning', icon: TriangleAlert, label: 'Degraded' },
  failing: { tone: 'danger', icon: CircleX, label: 'Failing' },
  // What it needs could not be read this time (Kafka, say): neither a pass nor a breach.
  unknown: { tone: 'neutral', icon: CircleDashed, label: 'Unchecked' },
};

/** A health tile's status (design system §9.24): text and icon, so colour is never the only signal. */
export function HealthPill({ level }: { level: HealthLevel }) {
  const { tone, icon, label } = PILLS[level];
  return (
    <StatusPill tone={tone} icon={icon}>
      {label}
    </StatusPill>
  );
}
