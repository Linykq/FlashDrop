'use client';

import { usePathname } from 'next/navigation';
import { type NavLinkItem, NavLinkList } from './nav-link-list';

/**
 * Marks the current page's link. Reading the pathname suspends while prerendering routes with unknown params,
 * so the navigation bar renders this inside Suspense, with the unmarked list as the fallback.
 */
export function CurrentNavLinks({ links }: { links: readonly NavLinkItem[] }) {
  return <NavLinkList links={links} current={usePathname()} />;
}
