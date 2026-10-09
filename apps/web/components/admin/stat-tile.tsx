import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

type StatTileProps = {
  /** Sentence case, no colon (§9.23). */
  label: string;
  /** The number, in place: it updates without animation. */
  value: ReactNode;
  /** "of 500 units", "$62,178.00 gross". */
  sub?: ReactNode;
  /** A health tile's status pill, at the top right. */
  status?: ReactNode;
  /** An anchor for links to the tile (the health summary's). */
  id?: string;
  className?: string;
};

/**
 * One number that answers a question (design system §1.5, §9.23): a card with the label, the value in
 * `text-title-1` with tabular figures, an optional sub-line and, on health tiles, a status pill.
 */
export function StatTile({ label, value, sub, status, id, className }: StatTileProps) {
  return (
    <div id={id} className={cx('flex flex-col rounded-lg bg-surface p-4 elevation-1 sm:p-5', className)}>
      {/* The pill wraps under the label in a tile too narrow for both (two up on a phone). */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className="text-footnote text-label-secondary">{label}</p>
        {status}
      </div>
      <p className="mt-1 text-title-1 tabular-nums">{value}</p>
      {sub && <p className="mt-1 text-footnote text-label-secondary tabular-nums">{sub}</p>}
    </div>
  );
}
