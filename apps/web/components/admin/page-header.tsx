import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

type PageHeaderProps = {
  title: ReactNode;
  /** Before the title: a thumbnail on a drop's page. */
  leading?: ReactNode;
  /** Under the title: an intro line or the drop's status line. */
  children?: ReactNode;
  /** At the top right of the title row: one filled action, the rest gray (§10.7). */
  actions?: ReactNode;
  className?: string;
};

/**
 * An admin page's large title (design system §9.19, §10.7): the `h1` in `text-title-1` with 32 px above it on
 * a phone and 48 px from 735 px, actions at the end of the row. The `h1` is marked for the bar's compact copy,
 * and it and the actions are where focus goes when the control that had it leaves (`focusPageStart`).
 */
export function PageHeader({ title, leading, children, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cx(
        'flex flex-wrap items-start justify-between gap-x-8 gap-y-4 pt-8 sm:flex-nowrap sm:pt-12',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-4 sm:flex-1">
        {leading}
        <div className="min-w-0">
          <h1 data-large-title tabIndex={-1} className="text-title-1 outline-none">
            {title}
          </h1>
          {children}
        </div>
      </div>
      {actions && (
        <div data-page-actions className="flex max-w-full shrink-0 flex-wrap items-center gap-3">
          {actions}
        </div>
      )}
    </header>
  );
}
