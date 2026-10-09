'use client';

import { CircleX } from 'lucide-react';
import type { MouseEvent, Ref } from 'react';
import { type CheckoutField, errorSummaryTitle, type FieldErrors, fieldId } from '../../lib/checkout-form';

type ErrorSummaryProps = {
  ref: Ref<HTMLElement>;
  /** The fields that failed the last submit, in DOM order, with what each needs. */
  fields: readonly CheckoutField[];
  errors: FieldErrors;
};

/**
 * The error summary of a failed submit (SD §8.3, design-system §10.4): a danger banner at the top of the form
 * that takes focus. A region named by its title and described by its list, so that one focus event reads the
 * count and every field to fix, once. No alert role as well: inserted with its text and focused at the same
 * time, it would be read twice (§13.3, as for the expired card). Each entry links to its field and moves
 * focus there, scrolled clear of the navigation bar.
 */
export function ErrorSummary({ ref, fields, errors }: ErrorSummaryProps) {
  return (
    <section
      ref={ref}
      aria-labelledby="error-summary-title"
      aria-describedby="error-summary-list"
      tabIndex={-1}
      className="flex animate-fade-in items-start gap-3 rounded-md bg-danger-tint py-3 pr-4 pl-4"
    >
      <CircleX className="shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <h2 id="error-summary-title" className="text-headline">
          {errorSummaryTitle(fields.length)}
        </h2>
        <ul id="error-summary-list" className="mt-1 text-callout">
          {fields.map((field) => (
            <li key={field}>
              <a
                href={`#${fieldId(field)}`}
                onClick={(event) => focusField(event, field)}
                className="inline-flex min-h-6 items-center text-label underline underline-offset-2"
              >
                {errors[field]}
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
 * both, and the root's scroll padding keeps it clear of the sticky bar. A radio group takes focus on its
 * checked radio, as Tab would.
 */
function focusField(event: MouseEvent<HTMLAnchorElement>, field: CheckoutField): void {
  const target =
    field === 'paymentMethod'
      ? (document.querySelector<HTMLInputElement>('input[name="paymentMethod"]:checked') ??
        document.getElementById(fieldId(field)))
      : document.getElementById(fieldId(field));
  if (!target) return;
  event.preventDefault();
  target.focus();
}
