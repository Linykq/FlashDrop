import type { Metadata } from 'next';
import { NotFoundState } from '../../components/layout/not-found-state';

export const metadata: Metadata = { title: 'Page not found' };

/**
 * A `notFound()` from a store page: unknown products, and from M3 other users' orders, which api answers
 * with 404 (§10.0). The store layout around it already brings the navigation bar and footer.
 */
export default function StoreNotFound() {
  return <NotFoundState />;
}
