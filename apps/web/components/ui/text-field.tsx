import { ChevronDown, CircleAlert } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cx } from '../../lib/cx';

type FieldFrameProps = {
  id: string;
  label: string;
  /** A format hint ("5 digits"), never a placeholder (§9.4). */
  helper?: string;
  /**
   * Shown under the field with `CircleAlert`; marks the control `aria-invalid`. Without one the control says
   * `aria-invalid="false"` outright: forms here are `noValidate`, and the browser would otherwise report a
   * required control that is still empty as invalid (Chrome does for a select) before any check has run.
   */
  error?: string;
  className?: string;
  children: (described: { 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode;
};

/** The ids of a field's error and helper text, which its control points at, error first (§9.4). */
export const errorId = (id: string) => `${id}-error`;
const helperId = (id: string) => `${id}-helper`;

/**
 * The parts every field shares: the control (with its floating label) and, under it, the error and the helper
 * text, 8 px below, both linked to the control with `aria-describedby`.
 */
function FieldFrame({ id, label, helper, error, className, children }: FieldFrameProps) {
  const describedBy = [error && errorId(id), helper && helperId(id)].filter(Boolean).join(' ');
  return (
    <div className={className}>
      <div className="relative">
        {children({
          'aria-invalid': Boolean(error),
          'aria-describedby': describedBy || undefined,
        })}
        <label
          htmlFor={id}
          className="field-label pointer-events-none absolute top-4 right-4 left-4 truncate text-body text-label-secondary"
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
        <p id={helperId(id)} className="mt-2 text-footnote text-label-secondary">
          {helper}
        </p>
      )}
    </div>
  );
}

// 56 px tall, value at 24 px from the top (§9.4): the padding centres a 25 px line 1 px lower than the box would.
const controlClass = (error: string | undefined) =>
  cx(
    'block h-14 w-full rounded-md border bg-surface pt-6 pb-1.75 pl-4 text-body text-label',
    'transition-colors duration-200 ease-standard',
    error ? 'border-danger' : 'border-control hover:border-label-secondary',
  );

type TextFieldProps = Omit<
  ComponentProps<'input'>,
  'id' | 'className' | 'placeholder' | 'aria-invalid' | 'aria-describedby' | 'children'
> &
  Omit<FieldFrameProps, 'children'>;

/**
 * A text field with an Apple-style floating label (§9.4): no placeholder; the label sits where one would and
 * rises as the field is focused or filled. Every field sets `type`, `inputMode` and `autoComplete`.
 */
export function TextField({ id, label, helper, error, className, ...input }: TextFieldProps) {
  return (
    <FieldFrame id={id} label={label} helper={helper} error={error} className={className}>
      {(described) => (
        <input
          {...input}
          {...described}
          id={id}
          placeholder=" "
          className={cx(controlClass(error), 'pr-4')}
        />
      )}
    </FieldFrame>
  );
}

type SelectFieldProps = Omit<
  ComponentProps<'select'>,
  'id' | 'className' | 'aria-invalid' | 'aria-describedby'
> &
  Omit<FieldFrameProps, 'children'>;

/**
 * A native select in the text field's frame (§9.4): its label rests where a text field's does while the empty
 * choice is selected, and rises once a value is chosen; `ChevronDown` sits 16 px from the right. A required
 * select also says so with `aria-required`: Chrome exposes `required` on a text field, but not on a collapsed
 * select.
 */
export function SelectField({ id, label, helper, error, className, children, ...select }: SelectFieldProps) {
  return (
    <FieldFrame id={id} label={label} helper={helper} error={error} className={className}>
      {(described) => (
        <>
          <select
            {...select}
            {...described}
            aria-required={select.required || undefined}
            id={id}
            className={cx(controlClass(error), 'appearance-none pr-10')}
          >
            {children}
          </select>
          <ChevronDown
            size={16}
            className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-label-secondary"
          />
        </>
      )}
    </FieldFrame>
  );
}
