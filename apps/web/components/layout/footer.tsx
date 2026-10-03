import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { cx } from '../../lib/cx';
import { ORDERS_HREF } from '../../lib/routes';
import { ThemeSwitcher } from '../theme/theme-switcher';
import type { NavAccount } from './nav-bar';

const REPOSITORY = 'https://github.com/Linykq/FlashDrop';

type FooterLink = { href: string; label: string; external?: boolean };

type FooterProps = {
  account: NavAccount | null;
  liveHref?: string | null;
};

/**
 * The storefront footer (§9.20). Checkout, the live room and admin have none. It sits in `page-wide`, like the
 * navigation bar, so both bars share the page's edges. The link groups are one `Footer` navigation landmark
 * with a heading per group, not a region each.
 */
export function Footer({ account, liveHref = null }: FooterProps) {
  const groups: { title: string; links: FooterLink[] }[] = [
    {
      title: 'Shop',
      links: [{ href: '/', label: 'Drops' }, ...(liveHref ? [{ href: liveHref, label: 'Live' }] : [])],
    },
    {
      title: 'Account',
      links: [
        { href: '/login', label: account ? 'Account' : 'Sign in' },
        ...(account ? [{ href: ORDERS_HREF, label: 'Orders' }] : []),
        ...(account?.adminHref ? [{ href: account.adminHref, label: 'Admin' }] : []),
      ],
    },
    {
      title: 'Project',
      links: [
        { href: REPOSITORY, label: 'Source on GitHub', external: true },
        { href: `${REPOSITORY}/blob/main/assets/catalog/CREDITS.md`, label: 'Image credits', external: true },
      ],
    },
  ];

  return (
    <footer className="border-separator border-t bg-bg-secondary text-footnote text-label-secondary">
      <div className="page-wide py-8 sm:py-10">
        {/* Two columns on phones, Project spanning both: the groups are short, and stacked one per row they
            would make the footer taller than a short page's content. */}
        <nav aria-label="Footer" className="grid grid-cols-2 gap-8 sm:grid-cols-3 sm:gap-(--grid-gap)">
          {groups.map(({ title, links }) => (
            <div key={title} className={cx(title === 'Project' && 'col-span-2 sm:col-span-1')}>
              <h2 className="font-semibold text-label">{title}</h2>
              <ul className="mt-2 flex flex-col gap-1">
                {links.map(({ href, label, external = false }) => (
                  <li key={label}>
                    <Link
                      href={href}
                      className="inline-flex min-h-6 items-center gap-1 transition-colors duration-200 ease-standard hover:text-label"
                    >
                      {label}
                      {external && <ArrowUpRight size={14} strokeWidth={1.5} />}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="mt-8 flex flex-col gap-4 border-separator border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p>FlashDrop is a demo store. No real payments are taken. MIT License.</p>
          <ThemeSwitcher />
        </div>
      </div>
    </footer>
  );
}
