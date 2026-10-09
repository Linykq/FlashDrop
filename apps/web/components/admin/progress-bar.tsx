import { cx } from '../../lib/cx';

/**
 * Determinate progress (design system §9.27): the photo upload. 4 px, accent fill, updated without a
 * transition because upload events arrive many times a second. Labelled by the visible "Uploading… 64%".
 */
export function ProgressBar({
  value,
  labelledBy,
  className,
}: {
  /** 0 to 100. */
  value: number;
  labelledBy: string;
  className?: string;
}) {
  const now = Math.round(Math.min(100, Math.max(0, value)));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={now}
      aria-labelledby={labelledBy}
      className={cx('h-1 overflow-clip rounded-full bg-fill-secondary', className)}
    >
      <div className="h-full rounded-full bg-accent" style={{ width: `${now}%` }} />
    </div>
  );
}

/**
 * Progress without an end the admin can see (§9.27): listing generation. A 40% fill slides across, only with
 * full motion; under reduced motion the bar isn't rendered and the status text and step spinner carry it.
 */
export function IndeterminateProgress({ labelledBy, className }: { labelledBy: string; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-labelledby={labelledBy}
      className={cx('h-1 overflow-clip rounded-full bg-fill-secondary motion-reduce:hidden', className)}
    >
      <div className="h-full w-2/5 rounded-full bg-accent motion-safe:animate-indeterminate" />
    </div>
  );
}
