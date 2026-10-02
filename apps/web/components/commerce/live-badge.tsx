import { cx } from '../../lib/cx';

type LiveBadgeProps = {
  /** `sm` (20 px) on tiles and in lists; `md` (24 px) everywhere else. */
  size?: 'sm' | 'md';
  /**
   * Only the home hero's and the live room's badge pulse: three cycles, then still (WCAG 2.2.2), so a page
   * never has more than two pulsing dots (§9.11).
   */
  pulse?: boolean;
};

/** Shown only while a drop or room is LIVE. The DOM text is "Live", so screen readers don't spell it out. */
export function LiveBadge({ size = 'md', pulse = false }: LiveBadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-xs bg-live text-caption font-semibold text-label-on-color uppercase tracking-[0.04em]',
        size === 'sm' ? 'h-5 px-1.5' : 'h-6 px-2',
      )}
    >
      <span
        aria-hidden="true"
        className={cx('size-1.5 rounded-full bg-label-on-color', pulse && 'motion-safe:animate-live-pulse')}
      />
      Live
    </span>
  );
}
