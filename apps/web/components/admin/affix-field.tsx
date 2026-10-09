import { CircleAlert } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cx } from '../../lib/cx';
import { errorId } from '../ui/text-field';

type AffixFieldProps = Omit<
  ComponentProps<'input'>,
  'id' | 'className' | 'placeholder' | 'aria-invalid' | 'aria-describedby' | 'children'
> & {
  id: string;
  label: string;
  /** Before the value: "$" (§9.4). */
  prefix?: string;
  /** After the value: "seconds", "units". */
  suffix?: string;
  helper?: string;
  error?: string;
  className?: string;
};

/**
 * A text field with a prefix or suffix (design system §9.4): the affix is `label-secondary` text inside the
 * container, outside the input's own box. Its label stays raised, like a select's, so it never sits on the
 * affix. Otherwise it is the shared text field: 56 px, floating label, error then helper under it, linked
 * with `aria-describedby`. The affix is part of that description too: the unit ("seconds") or currency ("$")
 * is otherwise only seen, never heard (WCAG 1.3.1).
 */
export function AffixField({
  id,
  label,
  prefix,
  suffix,
  helper,
  error,
  className,
  ...input
}: AffixFieldProps) {
  const helperId = `${id}-helper`;
  const prefixId = `${id}-prefix`;
  const suffixId = `${id}-suffix`;
  const describedBy = [error && errorId(id), prefix && prefixId, suffix && suffixId, helper && helperId]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={className}>
      <div
        className={cx(
          'relative flex h-14 items-baseline rounded-md border bg-surface transition-colors duration-200 ease-standard',
          'has-focus-visible:outline-3 has-focus-visible:outline-focus has-focus-visible:outline-offset-2',
          error ? 'border-danger' : 'border-control hover:border-label-secondary',
        )}
      >
        {prefix && (
          <span id={prefixId} className="pl-4 text-body text-label-secondary">
            {prefix}
          </span>
        )}
        <input
          {...input}
          id={id}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy || undefined}
          className={cx(
            'h-full min-w-0 flex-1 bg-transparent pt-6 pb-1.75 text-body text-label tabular-nums outline-none',
            prefix ? 'pl-1' : 'pl-4',
            suffix ? 'pr-2' : 'pr-4',
          )}
        />
        {suffix && (
          <span id={suffixId} className="pr-4 text-body text-label-secondary">
            {suffix}
          </span>
        )}
        <label
          htmlFor={id}
          className="pointer-events-none absolute top-2 left-4 origin-top-left text-caption text-label-secondary"
        >
          {label}
        </label>
      </div>
      {error && (
        <p id={errorId(id)} className="mt-2 flex items-start gap-1.5 text-footnote text-danger">
          <CircleAlert size={16} className="mt-px shrink-0" />
          {error}
        </p>
      )}
      {helper && (
        <p id={helperId} className="mt-2 text-footnote text-label-secondary">
          {helper}
        </p>
      )}
    </div>
  );
}
