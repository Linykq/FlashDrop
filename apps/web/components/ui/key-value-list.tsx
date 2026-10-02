import { cx } from '../../lib/cx';

export type KeyValueRow = { key: string; value: string | null };

type KeyValueListProps = {
  rows: readonly KeyValueRow[];
  /** `body` for product details, `callout` (the default) for orders, drop settings and admin. */
  size?: 'callout' | 'body';
  className?: string;
};

/**
 * Facts as a `<dl>` (§9.30): the key on the leading edge, the value end-aligned, hairlines between rows.
 * Values wrap and are never truncated; a row without a value is left out rather than shown empty.
 */
export function KeyValueList({ rows, size = 'callout', className }: KeyValueListProps) {
  return (
    <dl
      className={cx('divide-y divide-separator', size === 'body' ? 'text-body' : 'text-callout', className)}
    >
      {rows.map(({ key, value }) =>
        value === null ? null : (
          <div key={key} className="flex min-h-11 items-baseline justify-between gap-4 py-2.5">
            <dt className="shrink-0 text-label-secondary">{key}</dt>
            <dd className="text-end">{value}</dd>
          </div>
        ),
      )}
    </dl>
  );
}
