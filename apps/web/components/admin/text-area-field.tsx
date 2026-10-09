import { CircleAlert } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cx } from '../../lib/cx';
import { formatCount } from '../../lib/format';
import { errorId } from '../ui/text-field';

type TextAreaFieldProps = Omit<
  ComponentProps<'textarea'>,
  'id' | 'className' | 'placeholder' | 'aria-invalid' | 'aria-describedby' | 'children'
> & {
  id: string;
  label: string;
  helper?: string;
  error?: string;
  /** Shows "42/500" at the bottom right, in `danger` past the limit. */
  counter?: { count: number; max: number; min?: number };
  className?: string;
};

/**
 * The textarea of design system §9.4: the text field's frame with its label always raised, at least 120 px
 * tall, resizing vertically, with an optional character counter inside the frame. Error, then helper, under
 * it, both linked with `aria-describedby`; the counter too, so its limit is read with the field.
 */
export function TextAreaField({
  id,
  label,
  helper,
  error,
  counter,
  className,
  ...textarea
}: TextAreaFieldProps) {
  const helperId = `${id}-helper`;
  const counterId = `${id}-counter`;
  const outside =
    counter !== undefined && (counter.count > counter.max || counter.count < (counter.min ?? 0));
  const describedBy = [error && errorId(id), helper && helperId, counter && counterId]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={className}>
      <div className="relative">
        <textarea
          {...textarea}
          id={id}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy || undefined}
          className={cx(
            'block min-h-30 w-full resize-y rounded-md border bg-surface px-4 pt-7 text-body text-label',
            counter ? 'pb-8' : 'pb-3',
            'transition-colors duration-200 ease-standard',
            error ? 'border-danger' : 'border-control hover:border-label-secondary',
          )}
        />
        <label
          htmlFor={id}
          className="pointer-events-none absolute top-2 left-4 text-caption text-label-secondary"
        >
          {label}
        </label>
        {counter && (
          <span
            id={counterId}
            className={cx(
              'pointer-events-none absolute right-4 bottom-2 text-footnote tabular-nums',
              outside ? 'text-danger' : 'text-label-secondary',
            )}
          >
            <span aria-hidden="true">
              {formatCount(counter.count)}/{formatCount(counter.max)}
            </span>
            <span className="sr-only">
              {formatCount(counter.count)} of {formatCount(counter.max)} characters
            </span>
          </span>
        )}
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
