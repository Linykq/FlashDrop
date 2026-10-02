import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState } from '../ui/empty-state';

type RouteStateProps = { icon: LucideIcon; title: string; description: string; action: ReactNode };

/** The not-found and error pages: an empty state whose title is the page's `h1`, centred in `page-form` (§10.0). */
export function RouteState(props: RouteStateProps) {
  return (
    <div className="page-form py-(--section-space)">
      <EmptyState {...props} level="page" />
    </div>
  );
}
