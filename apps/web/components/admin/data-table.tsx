import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { ScrollRegion } from './scroll-region';

type DataTableProps = {
  /** Unique on the page: the caption's id, which the scrolling region is labelled by. */
  id: string;
  caption: string;
  /** Hidden when a heading on the page already names the table (§9.22). */
  hideCaption?: boolean;
  /** `<thead>` and `<tbody>`, built with `Th` and `Td`. */
  children: ReactNode;
  className?: string;
};

/**
 * An admin data table (design system §9.22) in a card. `overflow-clip` rounds the corners without creating a
 * scroll container, so from 735 px the header row sticks under the navigation bar, and focus brought into
 * view clears that header as well as the bar (WCAG 2.4.11). Below 735 px the table scrolls sideways in its own
 * region, with the first column sticky, at most about half the region wide and edged with a hairline, so the
 * columns that scroll under it can be seen; the header doesn't stick there. At any width, a table wider than
 * its card scrolls the same way rather than being cut off (WCAG 1.4.10, 2.1.1); its header then sticks to the
 * region rather than the page, the price of reaching every column.
 */
export function DataTable({ id, caption, hideCaption = true, children, className }: DataTableProps) {
  const captionId = `${id}-caption`;
  return (
    <div className={cx('overflow-clip rounded-lg bg-surface elevation-1', className)}>
      {/* Positioned, so the visually hidden text in its cells (absolute) scrolls and clips with the table. */}
      <ScrollRegion
        labelledBy={captionId}
        className="relative max-sm:overflow-x-auto data-overflows:overflow-x-auto"
      >
        <table className="w-full border-separate border-spacing-0 text-callout sm:[&_tbody_:is(a,button,input)]:scroll-mt-9">
          <caption
            id={captionId}
            className={hideCaption ? 'sr-only' : 'px-4 pt-4 pb-2 text-start text-headline'}
          >
            {caption}
          </caption>
          {children}
        </table>
      </ScrollRegion>
    </div>
  );
}

type CellProps = {
  children?: ReactNode;
  /** Right-aligned, tabular figures (§9.22). */
  numeric?: boolean;
  /**
   * The row's first cell: 16 px outer padding, sticky while the table scrolls sideways on a phone, where its
   * content is capped at 160 px so it never covers the columns scrolling under it (titles wrap, slugs truncate).
   */
  first?: boolean;
  /** The row's last cell: 16 px outer padding. */
  last?: boolean;
  className?: string;
};

function cellClass({ numeric, first, last }: CellProps): string {
  return cx(
    numeric ? 'text-end tabular-nums' : 'text-start',
    first ? 'pl-4' : 'pl-3',
    last ? 'pr-4' : 'pr-3',
    // The sticky first column covers what scrolls under it; the hairline says it stays while the rest moves.
    first && 'max-sm:sticky max-sm:left-0 max-sm:z-1 max-sm:border-r max-sm:bg-surface',
  );
}

/** A header cell: 36 px, sentence case, solid surface; sticky under the bar from 735 px. */
export function Th(props: CellProps & { scope?: 'col' | 'row' }) {
  const { children, scope = 'col', className } = props;
  return (
    <th
      scope={scope}
      className={cx(
        'h-9 whitespace-nowrap border-separator border-b bg-surface align-middle text-footnote font-medium text-label-secondary',
        'sm:sticky sm:top-[calc(var(--nav-height)+env(safe-area-inset-top))] sm:z-(--z-sticky)',
        cellClass(props),
        className,
      )}
    >
      {children}
    </th>
  );
}

/** A body cell: rows at least 52 px tall, hairlines between rows, no row hover (only the first cell links). */
export function Td(props: CellProps) {
  const { children, className } = props;
  return (
    <td
      className={cx(
        'h-13 border-separator py-2 align-middle [tr+tr>&]:border-t',
        cellClass(props),
        className,
      )}
    >
      {/* A cell's own max-width is not honoured by the auto table layout; a block inside it caps the
          column, because it caps the content's contribution to the column's width. */}
      {props.first ? <div className="max-sm:max-w-40">{children}</div> : children}
    </td>
  );
}
