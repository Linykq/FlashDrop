import { cx } from '../../lib/cx';

/** Initials in a circle; there are no profile photos (§9.25). The initials are decorative: name the link instead. */
export function Avatar({ initials, size = 'sm' }: { initials: string; size?: 'sm' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-fill-tertiary font-semibold text-label',
        size === 'sm' ? 'size-7 text-caption' : 'size-10 text-headline',
      )}
    >
      {initials}
    </span>
  );
}
