import Link from 'next/link';
import { cx } from '../../lib/cx';

export type NavLinkItem = { href: string; label: string; live?: boolean };

/** Links on `material-bar` are `label` at 80% (6.30:1 over the worst content), full `label` on hover or current. */
export const navLinkClass =
  'inline-flex h-11 items-center text-footnote text-label/80 transition-colors duration-200 ease-standard hover:text-label aria-[current=page]:text-label';

/**
 * The bar's page links. From 735 px they read as text; on a phone only "Live" remains, as a pill (§9.18).
 * The live dot pulses three times and then rests (WCAG 2.2.2), and never under reduced motion.
 */
export function NavLinkList({ links, current }: { links: readonly NavLinkItem[]; current: string | null }) {
  return (
    <ul className="flex items-center gap-6">
      {links.map(({ href, label, live = false }) => (
        <li key={href} className={live ? undefined : 'max-sm:hidden'}>
          <Link
            href={href}
            aria-current={href === current ? 'page' : undefined}
            className={cx(navLinkClass, 'gap-1.5')}
          >
            {live ? (
              <span className="inline-flex items-center gap-1.5 max-sm:h-7 max-sm:rounded-full max-sm:bg-fill-tertiary max-sm:px-2.5 max-sm:text-caption max-sm:font-medium max-sm:text-label">
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-live motion-safe:animate-live-pulse"
                />
                {label}
              </span>
            ) : (
              label
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
