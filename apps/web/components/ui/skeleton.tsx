import { cx } from '../../lib/cx';

/**
 * A still placeholder with the final content's exact box: no shimmer, no pulse (§9.16). Decorative; the region
 * it fills carries `aria-busy` until the content arrives.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx('skeleton', className)} />;
}

const lineClass = {
  caption: 'text-caption',
  footnote: 'text-footnote',
  callout: 'text-callout',
  body: 'text-body',
  headline: 'text-headline',
  'title-3': 'text-title-3',
  'title-2': 'text-title-2',
  'title-1': 'text-title-1',
  intro: 'text-intro',
  'display-2': 'text-display-2',
  'display-1': 'text-display-1',
} as const;

/**
 * One line of text in a type style: a bar as tall as the font size, centred in the style's line height, so the
 * text that replaces it takes the same space.
 */
export function SkeletonText({ style, className }: { style: keyof typeof lineClass; className?: string }) {
  return (
    <div aria-hidden="true" className={cx('flex h-lh items-center', lineClass[style], className)}>
      <div className="skeleton h-[1em] w-full" />
    </div>
  );
}
