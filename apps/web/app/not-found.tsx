import type { Metadata } from 'next';
import { NotFoundState } from '../components/layout/not-found-state';
import { StoreShell } from '../components/layout/store-shell';

export const metadata: Metadata = { title: 'Page not found' };

/**
 * Unknown URLs (§10.0). It sits outside the route groups, so it brings the store's chrome itself; a
 * `notFound()` inside the store renders `(store)/not-found.tsx` within the store's own chrome instead.
 */
export default function NotFound() {
  return (
    <StoreShell>
      <NotFoundState />
    </StoreShell>
  );
}
