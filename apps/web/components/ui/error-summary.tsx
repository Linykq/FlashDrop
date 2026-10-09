'use client';

import { CircleX } from 'lucide-react';
import { type MouseEvent, type Ref, useId } from 'react';
import { cx } from '../../lib/cx';

export type ErrorSummaryItem = {
  /** The field the entry links to; its id. */
  targetId: string;
  message: string;
  /** Where focus goes instead of the element with `targetId` (a radio group's checked radio). */
  focusTarget?: () => HTMLElement | null;
};

type ErrorSummaryProps = {
  ref: Ref<HTMLElement>;
  /** "Fix 2 fields to continue". */
  title: string;
  /** Still-failing fields, in the form's order. */
  items: readonly ErrorSummaryItem[];
  /** Fading out: every field it listed has been fixed (200 ms, then the form removes it). */
  leaving?: boolean;
};

/**
 * The error summary of a failed submit (SD §8.3, design-system §10.4, §10.9): a danger banner at the top of
 * the form that takes focus. A region named by its title and described by its list, so that one focus event
 * reads the count and every field to fix, once. No alert role as well: inserted with its text and focused at
 * the same time, it would be read twice (§13.3, as for the expired card). Each entry links to its field and
 * moves focus there, scrolled clear of the navigation bar. The form keeps it current as fields are fixed, so it
 * never lists a field that is fine now; once none is left it fades out.
 */
export function ErrorSummary({ ref, title, items, leaving = false }: ErrorSummaryProps) {
  const titleId = useId();
  const listId = useId();
  return (
    <section
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={listId}
      tabIndex={-1}
      className={cx(
        'flex items-start gap-3 rounded-md bg-danger-tint py-3 pr-4 pl-4',
        leaving ? 'animate-fade-out' : 'animate-fade-in',
      )}
    >
      <CircleX className="shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="text-headline">
          {title}
        </h2>
        <ul id={listId} className="mt-1 text-callout">
          {items.map((item) => (
            <li key={item.targetId}>
              <a
                href={`#${item.targetId}`}
                onClick={(event) => focusItem(event, item)}
                className="inline-flex min-h-6 items-center text-label underline underline-offset-2"
              >
                {item.message}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * Following the link alone would scroll to the field without focusing it in every browser; focusing it does
 * both, and the root's scroll padding keeps it clear of the sticky bars.
 */
function focusItem(event: MouseEvent<HTMLAnchorElement>, item: ErrorSummaryItem): void {
  const target = item.focusTarget?.() ?? document.getElementById(item.targetId);
  if (!target) return;
  event.preventDefault();
  target.focus();
}
