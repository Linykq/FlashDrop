'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  CHECKOUT_PAYMENT_METHODS,
  COUNTRIES,
  erroredFields,
  errorSummaryTitle,
  FIELD_SPECS,
  type FieldErrors,
  fieldErrorsFromIssues,
  fieldId,
  type ShippingField,
  US_STATES,
  validateCheckout,
} from '../../lib/checkout-form';
import { checkoutKey, forgetCheckoutKey } from '../../lib/checkout-key';
import { checkoutHref, loginHref } from '../../lib/routes';
import { orderRequests } from '../../lib/use-order-requests';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { ErrorSummary, type ErrorSummaryItem } from '../ui/error-summary';
import { RadioCard } from '../ui/radio-card';
import { errorId, SelectField, TextField } from '../ui/text-field';
import { toast } from '../ui/toast';

const subscribeNever = () => () => {};

/** How a submit ended for the page around the form. */
export type SubmitEnd =
  /** The order is placed (or was already): it leaves checkout for its status page. */
  | 'placed'
  /** api answered 410: the hold expired before the submit arrived. */
  | 'expired';

type CheckoutFormProps = {
  orderId: string;
  /** "Pay $258.00": the order's total, formatted (§12.2). */
  payLabel: string;
  /** Where the order goes once it leaves checkout (§10.4). */
  orderPageHref: string;
  /**
   * A submit is in flight, from the press until its answer (and, once placed, until the order page shows).
   * The page owns it: it keeps the hold on screen meanwhile.
   */
  busy: boolean;
  /** Stable (a state setter): the form's effects depend on it. */
  onBusyChange: (busy: boolean) => void;
  onEnd: (end: SubmitEnd) => void;
  /** Shown just above Pay: the hold's extension offer, while the hold card is out of view. */
  beforePay?: ReactNode;
};

/**
 * Shipping and payment, submitted once (SD §5.2, §8.3, design-system §10.4): a native form with the shipping
 * fields in a fieldset and the payment method as a native radio group, so the browser brings autofill, arrow
 * keys and Enter to submit. Client checks run first; with errors, the summary takes focus and links to each
 * field. The submit carries the order's Idempotency-Key (`checkout-key.ts`), so pressing Pay again after a
 * failure, or after a reload, replays rather than submits twice. Pay stays focusable while in flight
 * (`aria-disabled` + `aria-busy`, never `disabled`), and a second press is ignored.
 */
export function CheckoutForm({
  orderId,
  payLabel,
  orderPageHref,
  busy,
  onBusyChange,
  onEnd,
  beforePay,
}: CheckoutFormProps) {
  const router = useRouter();
  const [errors, setErrors] = useState<FieldErrors>({});
  // Shown after a failed submit, listing the fields that still fail as they are fixed one by one. Once the
  // last is fixed it fades out over 200 ms with what it said last (`leaving`), then goes.
  const [summary, setSummary] = useState<{ leaving: ErrorSummaryItem[] | null } | null>(null);
  // Bumped by each failed submit, which moves focus to the summary, including one that repeats the last.
  const [failedSubmits, setFailedSubmits] = useState(0);
  const [failed, setFailed] = useState(false);
  const summaryRef = useRef<HTMLElement>(null);
  const running = useRef<AbortController | null>(null);
  // Until hydration Pay is a plain button, so a press that comes first does nothing rather than submit the form
  // natively, which would reload the page and drop what was typed.
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

  // Next keeps a page it navigated away from mounted but hidden (React <Activity>): hiding runs this cleanup
  // and revealing (Back) runs the effect again with state kept. So leaving abandons a submit in flight (its key
  // stays stored, so the next press replays its answer), and a page shown again starts at Pay, never at the
  // "Processing…" it was left with, while the page asks the server whether the order is still a hold.
  useEffect(() => {
    onBusyChange(false);
    return () => {
      running.current?.abort();
      running.current = null;
    };
  }, [onBusyChange]);

  useEffect(() => {
    if (failedSubmits > 0) summaryRef.current?.focus();
  }, [failedSubmits]);

  // Focus is on the field just fixed by then, so nothing is lost when the summary goes.
  const leaving = summary?.leaving ?? null;
  useEffect(() => {
    if (leaving === null) return;
    const timer = setTimeout(() => setSummary(null), 200);
    return () => clearTimeout(timer);
  }, [leaving]);

  function showErrors(next: FieldErrors): void {
    setErrors(next);
    setSummary({ leaving: null });
    setFailedSubmits((count) => count + 1);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (running.current) return;
    setFailed(false);
    const checked = validateCheckout(new FormData(event.currentTarget));
    if (!checked.ok) {
      showErrors(checked.errors);
      return;
    }
    setErrors({});
    setSummary(null);

    const controller = new AbortController();
    running.current = controller;
    onBusyChange(true);
    let settled = false;
    try {
      const requests = await orderRequests();
      const outcome = requests
        ? await requests.submitCheckout(
            { orderId, key: checkoutKey(orderId), body: checked.body },
            controller.signal,
          )
        : ({ kind: 'failed' } as const);
      switch (outcome.kind) {
        case 'placed':
        case 'already-placed':
        case 'closed':
          // The order has left checkout. Pay keeps "Processing…" until its status page is shown.
          settled = true;
          forgetCheckoutKey(orderId);
          if (outcome.kind === 'already-placed')
            toast({ message: 'This order was already placed.', tone: 'info' });
          onEnd('placed');
          router.push(orderPageHref);
          return;
        case 'expired':
          forgetCheckoutKey(orderId);
          onEnd('expired');
          return;
        case 'signed-out':
          settled = true;
          router.push(loginHref(checkoutHref(orderId)));
          return;
        case 'invalid': {
          const fieldErrors = fieldErrorsFromIssues(outcome.issues);
          if (fieldErrors) showErrors(fieldErrors);
          else setFailed(true);
          return;
        }
        case 'failed':
          // The key is kept: Pay again replays this submit if it landed after all.
          setFailed(true);
          return;
      }
    } catch (error) {
      // Aborted: checkout went away. Nothing else rejects.
      if (!controller.signal.aborted) throw error;
    } finally {
      if (running.current === controller && !settled) {
        running.current = null;
        onBusyChange(false);
      }
    }
  }

  /**
   * A field that had an error loses it once it passes, and leaves the summary with it; no new errors appear
   * until the next submit.
   */
  function recheck(form: HTMLFormElement): void {
    if (Object.keys(errors).length === 0) return;
    const checked = validateCheckout(new FormData(form));
    const still: FieldErrors = {};
    for (const field of erroredFields(errors)) {
      const message = checked.ok ? undefined : checked.errors[field];
      if (message) still[field] = message;
    }
    if (erroredFields(still).length === erroredFields(errors).length) return;
    setErrors(still);
    if (erroredFields(still).length === 0 && summary !== null) setSummary({ leaving: summaryItems(errors) });
  }

  const field = (name: ShippingField) => ({
    id: fieldId(name),
    name,
    label: FIELD_SPECS[name].label,
    autoComplete: FIELD_SPECS[name].autoComplete,
    helper: FIELD_SPECS[name].helper,
    required: FIELD_SPECS[name].required,
    error: errors[name],
  });

  return (
    <form
      id="checkout-form"
      // Should the form ever submit natively, it posts: an address never lands in a URL, where a GET would put
      // it, and with it in the history and the access logs.
      method="post"
      noValidate
      onSubmit={(event) => void submit(event)}
      onChange={(event) => recheck(event.currentTarget)}
    >
      {summary && (
        <ErrorSummary
          ref={summaryRef}
          title={errorSummaryTitle((summary.leaving ?? summaryItems(errors)).length)}
          items={summary.leaving ?? summaryItems(errors)}
          leaving={summary.leaving !== null}
        />
      )}

      {/* min-w-0: a fieldset is min-content wide by default, which would push a field past a 320 px screen. */}
      <fieldset className={summary ? 'mt-8 min-w-0' : 'min-w-0'}>
        <legend className="text-title-3">Shipping</legend>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextField
            {...field('name')}
            type="text"
            maxLength={FIELD_SPECS.name.maxLength}
            className="sm:col-span-2"
          />
          <TextField
            {...field('line1')}
            type="text"
            maxLength={FIELD_SPECS.line1.maxLength}
            className="sm:col-span-2"
          />
          <TextField
            {...field('line2')}
            type="text"
            maxLength={FIELD_SPECS.line2.maxLength}
            className="sm:col-span-2"
          />
          <TextField {...field('city')} type="text" maxLength={FIELD_SPECS.city.maxLength} />
          <SelectField {...field('state')} defaultValue="">
            <option value="" disabled hidden />
            {US_STATES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </SelectField>
          <TextField
            {...field('postalCode')}
            type="text"
            inputMode="numeric"
            maxLength={FIELD_SPECS.postalCode.maxLength}
          />
          <SelectField {...field('country')} defaultValue={COUNTRIES[0].code}>
            {COUNTRIES.map(({ code, name }) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </SelectField>
        </div>
      </fieldset>

      <fieldset
        className="mt-10 min-w-0"
        aria-describedby={errors.paymentMethod ? errorId(fieldId('paymentMethod')) : undefined}
      >
        <legend className="text-title-3">Payment</legend>
        {errors.paymentMethod && (
          <p id={errorId(fieldId('paymentMethod'))} className="mt-2 text-footnote text-danger">
            {errors.paymentMethod}
          </p>
        )}
        <div className="mt-4 grid gap-3">
          {CHECKOUT_PAYMENT_METHODS.map(({ method, title, description }) => (
            <RadioCard
              key={method}
              id={`payment-${method}`}
              name="paymentMethod"
              value={method}
              defaultChecked={method === 'pm_ok'}
              aria-invalid={errors.paymentMethod ? true : undefined}
              title={title}
              description={description}
            />
          ))}
        </div>
      </fieldset>

      {beforePay}
      {failed && (
        <Banner tone="danger" alert className="mt-6 animate-fade-in">
          Couldn't place your order. Check your connection and try again.
        </Banner>
      )}
      <Button
        type={hydrated ? 'submit' : 'button'}
        size="lg"
        shape="rounded"
        fullWidth
        loading={busy}
        className="mt-6"
      >
        {busy ? 'Processing…' : payLabel}
      </Button>
      <p className="mt-3 text-center text-footnote text-label-secondary">
        This is a demo store. No real payment is taken.
      </p>
    </form>
  );
}

/** The summary's rows: each failing field in the form's order, linking to it (§10.4). */
function summaryItems(errors: FieldErrors): ErrorSummaryItem[] {
  return erroredFields(errors).map((field) => ({
    targetId: fieldId(field),
    message: errors[field] ?? '',
    // A radio group takes focus on its checked radio, as Tab would.
    focusTarget:
      field === 'paymentMethod'
        ? () => document.querySelector<HTMLInputElement>('input[name="paymentMethod"]:checked')
        : undefined,
  }));
}
