import { Eye } from 'lucide-react';
import { cx } from '../../lib/cx';
import { formatCount } from '../../lib/format';

/**
 * The gateway's real viewer count, including 1 (§9.11). Never announced: it changes every few seconds and
 * means nothing urgent. On video it sits on `material-overlay`.
 */
export function ViewerCount({ count, onVideo = false }: { count: number; onVideo?: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-caption font-medium tabular-nums',
        onVideo ? 'material-overlay' : 'bg-fill-tertiary text-label',
      )}
    >
      <Eye size={14} strokeWidth={1.5} />
      {formatCount(count)}
      <span className="sr-only"> watching</span>
    </span>
  );
}
