'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { loginHref } from '../../lib/routes';

/**
 * "Sign in", returning to the current page afterwards (§10.6). Reading the pathname suspends while
 * prerendering routes with unknown params, so callers render it inside Suspense with a plain link.
 */
export function SignInLink({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <Link href={pathname === '/login' ? '/login' : loginHref(pathname)} className={className}>
      Sign in
    </Link>
  );
}
