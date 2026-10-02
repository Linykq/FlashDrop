import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

type EmptyStateProps = {
  /** Omitted for an icon-free state, such as the home hero's. */
  icon?: LucideIcon;
  title: string;
  description: string;
  /** An md tinted pill, if there is a next step. */
  action?: ReactNode;
  /** `page` promotes the title to the page's `h1` in `text-title-1` and leaves the padding to the page (§10.0). */
  level?: 'section' | 'page';
  className?: string;
};

/** "Nothing here yet", said calmly, with the next step if there is one (§9.17). */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  level = 'section',
  className,
}: EmptyStateProps) {
  const Heading = level === 'page' ? 'h1' : 'h2';
  return (
    <div className={cx('flex flex-col items-center text-center', level === 'section' && 'py-16', className)}>
      {Icon && <Icon size={40} strokeWidth={1.5} className="mb-3 text-label-tertiary" />}
      <Heading className={level === 'page' ? 'text-title-1' : 'text-title-3'}>{title}</Heading>
      <p className="mt-2 max-w-100 text-callout text-label-secondary">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
