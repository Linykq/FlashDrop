'use client';

import { ArrowUpRight, HeartPulse, Layers, type LucideIcon, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type SidebarItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** The paths this item is current for: its own area, including pages reached from it. */
  matches: readonly string[];
};

const ITEMS: readonly SidebarItem[] = [
  { href: '/admin/drops', label: 'Drops', icon: Layers, matches: ['/admin/drops', '/admin/dashboard'] },
  { href: '/admin/listings/new', label: 'New listing', icon: Sparkles, matches: ['/admin/listings'] },
  { href: '/admin/health', label: 'Health', icon: HeartPulse, matches: ['/admin/health'] },
];

const isWithin = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

const itemClass =
  'flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 text-callout text-label transition-colors duration-100 ease-standard hover:bg-fill-quaternary hover:duration-200 active:bg-fill-tertiary active:duration-0 data-current:bg-fill-tertiary data-current:font-semibold';

/**
 * The admin sidebar (design system §10.7): 240 px and sticky beside the content from 1069 px, a row of the
 * same links under the bar below that, scrolling sideways. The current area's item is marked, also on the
 * pages reached from it (a drop's dashboard is under Drops). The storefront link leaves the area, so its icon
 * is `ArrowUpRight` (§7).
 */
export function AdminSidebar({ pathname = null }: { pathname?: string | null }) {
  return (
    <nav
      aria-label="Admin"
      className="max-md:relative max-md:-mx-(--page-margin) max-md:overflow-x-auto max-md:px-(--page-margin) md:sticky md:top-[calc(var(--nav-height)+env(safe-area-inset-top))] md:self-start md:pt-12"
    >
      <ul className="flex gap-1 py-3 md:flex-col md:py-0">
        {ITEMS.map(({ href, label, icon: Icon, matches }) => {
          const current = pathname !== null && matches.some((base) => isWithin(pathname, base));
          return (
            <li key={href}>
              <Link
                href={href}
                // `page` on the area's own page, `true` on a page reached from it (a drop's dashboard).
                aria-current={current ? (pathname === href ? 'page' : 'true') : undefined}
                data-current={current || undefined}
                className={itemClass}
              >
                <Icon size={20} className="shrink-0" />
                {label}
              </Link>
            </li>
          );
        })}
        <li aria-hidden="true" className="mx-3 my-2 w-px bg-separator md:h-px md:w-auto" />
        <li>
          <Link href="/" className={itemClass}>
            <ArrowUpRight size={20} className="shrink-0" />
            Storefront
          </Link>
        </li>
      </ul>
    </nav>
  );
}

/** The sidebar with the current page marked. Reading the pathname suspends while prerendering. */
export function CurrentAdminSidebar() {
  return <AdminSidebar pathname={usePathname()} />;
}
