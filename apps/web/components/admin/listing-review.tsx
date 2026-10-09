'use client';

import {
  LISTING_LIMITS,
  type ListingJob,
  type ListingUncertainty,
  PRODUCT_CATEGORIES,
  PRODUCT_CONDITIONS,
} from '@flashdrop/contracts';
import { ChevronDown, CircleAlert, CircleX, Pencil, Plus, Sparkles, TriangleAlert, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, type Ref, useId, useMemo, useRef, useState, useTransition } from 'react';
import { approveListing } from '../../app/admin/_lib/actions';
import { cx } from '../../lib/cx';
import { formatCount, plural } from '../../lib/format';
import { announce } from '../ui/announcer';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import { errorId } from '../ui/text-field';
import { toast } from '../ui/toast';
import { ChipInput } from './chip-input';
import {
  characterCount,
  type ErrorKey,
  errorKeyOf,
  FIELD_LABELS,
  fieldOfKey,
  focusKeyOf,
  isEdited,
  isEmptyValue,
  issueErrors,
  type ReviewErrors,
  type ReviewField,
  type ReviewValues,
  requiredAttributes,
  reviewBanner,
  reviewStatus,
  toWire,
  validateReview,
  valuesFromDraft,
} from './listing-review-model';

const CATEGORY_LABELS: Readonly<Record<(typeof PRODUCT_CATEGORIES)[number], string>> = {
  apparel: 'Apparel',
  audio: 'Audio',
  bags: 'Bags',
  beauty: 'Beauty',
  eyewear: 'Eyewear',
  footwear: 'Footwear',
  fragrance: 'Fragrance',
  home: 'Home',
  tech: 'Tech',
  watches: 'Watches',
};

const CONDITION_LABELS: Readonly<Record<(typeof PRODUCT_CONDITIONS)[number], string>> = {
  new: 'New',
  used: 'Used',
  refurbished: 'Refurbished',
};

const UNCERTAINTY_FALLBACK = 'Not visible in the photos. Add it if you know it, or leave it empty.';

const controlClass = (error: string | undefined) =>
  cx(
    'block w-full rounded-md border bg-surface px-4 text-body text-label transition-colors duration-200 ease-standard',
    error ? 'border-danger' : 'border-control hover:border-label-secondary',
  );

/** Error keys in the form's order, for the summary: each field, a list's own problem before its entries'. */
function orderedKeys(errors: ReviewErrors, highlights: number): ErrorKey[] {
  const keys: ErrorKey[] = [];
  for (const field of Object.keys(FIELD_LABELS) as ReviewField[]) {
    if (errors[field]) keys.push(field);
    if (field === 'highlights') {
      for (let index = 0; index < highlights; index += 1) {
        if (errors[`highlights.${index}`]) keys.push(`highlights.${index}`);
      }
    }
  }
  return keys;
}

/**
 * The listing review (SD §10, design system §10.9): every field pre-filled from the model's draft and marked
 * AI until the admin changes it ("Edited", the edit-rate metric), each uncertainty the model listed as a
 * prompt on its field, the job's issues as field errors, and the checks of `ListingDraft` itself. Nothing is
 * published until the admin approves; api validates the listing again before it creates the product.
 * Model output is rendered as text, never as HTML.
 */
export function ListingReview({ job }: { job: ListingJob }) {
  const router = useRouter();
  const prefix = useId();
  const draft = useMemo(() => valuesFromDraft(job.draft), [job.draft]);
  const [values, setValues] = useState<ReviewValues>(draft);
  const [touched, setTouched] = useState<ReadonlySet<ReviewField>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<ReviewErrors>(() => issueErrors(job.issues));
  const [settled, setSettled] = useState<ReadonlySet<ReviewField>>(new Set());
  const [summary, setSummary] = useState<ErrorKey[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const summaryRef = useRef<HTMLElement>(null);

  const uncertainties = job.draft?.uncertainties ?? [];
  const open = uncertainties.filter((uncertainty) => !settled.has(uncertainty.field));
  const clientErrors = useMemo(() => validateReview(values), [values]);
  const errorOf = (key: ErrorKey): string | undefined =>
    serverErrors[key] ?? (attempted || touched.has(fieldOfKey(key)) ? clientErrors[key] : undefined);

  const idOf = (key: ErrorKey) => `${prefix}-${key.replace('.', '-')}`;
  const addHighlightId = `${prefix}-highlights-add`;
  /** The id of what an error of `key` takes focus to (`focusKeyOf`). */
  const targetOf = (key: ErrorKey) => {
    const target = focusKeyOf(key, values.highlights.length);
    return target === null ? addHighlightId : idOf(target);
  };

  function update<F extends ReviewField>(field: F, value: ReviewValues[F]) {
    setValues((current) => ({ ...current, [field]: value }));
    // An edit answers the field's uncertainty and replaces the job's issues on it with the form's own checks.
    setSettled((current) => (current.has(field) ? current : new Set(current).add(field)));
    setServerErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(next) as ErrorKey[]) if (fieldOfKey(key) === field) delete next[key];
      return next;
    });
  }

  const touch = (field: ReviewField) =>
    setTouched((current) => (current.has(field) ? current : new Set(current).add(field)));

  function confirm(field: ReviewField) {
    setSettled((current) => new Set(current).add(field));
    // The prompt and its button leave; focus goes to the field it was about.
    requestAnimationFrame(() => document.getElementById(targetOf(field))?.focus());
  }

  function approve() {
    if (pending) return;
    setAttempted(true);
    setFailure(null);
    const errors = { ...validateReview(values), ...serverErrors };
    const keys = orderedKeys(errors, values.highlights.length);
    if (keys.length > 0) {
      setSummary(keys);
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setSummary(null);
    startTransition(async () => {
      const result = await approveListing(job.id, { listing: toWire(values, open) });
      if (result.ok) {
        toast({ message: 'Published.' });
        router.push(`/p/${result.value.slug}`);
        return;
      }
      const fieldErrors: ReviewErrors = {};
      for (const [path, message] of Object.entries(result.failure.fields ?? {})) {
        const key = errorKeyOf(path);
        if (key !== null)
          fieldErrors[key] = /^[a-z]/.test(message)
            ? `${FIELD_LABELS[fieldOfKey(key)]} ${message}.`
            : message;
      }
      setServerErrors(fieldErrors);
      setFailure(result.failure.message);
    });
  }

  const unchanged = (Object.keys(FIELD_LABELS) as ReviewField[]).filter(
    (field) => !isEdited(field, values, draft),
  ).length;
  const required = requiredAttributes(values.category);
  const banner = reviewBanner(job);
  // The summary lists what was wrong at the last approve, minus what has been fixed since: a fixed field's
  // link would otherwise stay, empty, in the tab order, and the count would overstate what is left.
  const shownSummary = (summary ?? []).filter((key) => errorOf(key) !== undefined);

  const shell = (
    field: ReviewField,
    controlId: string,
    extra: Pick<ShellProps, 'helper' | 'counter' | 'group' | 'paired'> = {},
  ): Omit<ShellProps, 'children'> => ({
    controlId,
    label: FIELD_LABELS[field],
    badge: job.draft === null ? null : isEdited(field, values, draft) ? 'edited' : 'ai',
    prompts: settled.has(field) ? [] : uncertainties.filter((uncertainty) => uncertainty.field === field),
    onConfirm: () => confirm(field),
    error: errorOf(field),
    empty: isEmptyValue(values[field]),
    required: required.includes(field),
    ...extra,
  });

  return (
    <form
      noValidate
      aria-busy={pending || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        approve();
      }}
      className="flex flex-col gap-8"
    >
      {banner && (
        <Banner
          tone="warning"
          title={banner.title}
          action={
            banner.startOver && (
              <Link
                href="/admin/listings/new"
                className="inline-flex min-h-6 items-center text-callout font-medium text-label underline underline-offset-4"
              >
                Start over
              </Link>
            )
          }
        >
          {banner.body}
        </Banner>
      )}
      {shownSummary.length > 0 && (
        <ErrorSummary
          ref={summaryRef}
          keys={shownSummary}
          message={(key) => errorOf(key) ?? ''}
          targetOf={targetOf}
        />
      )}
      {failure && shownSummary.length === 0 && (
        <Banner tone="danger" alert>
          {failure}
        </Banner>
      )}
      {job.draft !== null && (
        <p className="-mb-2 text-footnote text-label-secondary">
          Fields marked AI were generated from your photos. Review every field before publishing.
        </p>
      )}

      <FieldShell
        {...shell('title', idOf('title'), {
          counter: { count: characterCount(values.title), ...LISTING_LIMITS.title },
        })}
      >
        {(describedBy) => (
          <input
            id={idOf('title')}
            type="text"
            autoComplete="off"
            value={values.title}
            aria-invalid={Boolean(errorOf('title'))}
            aria-describedby={describedBy}
            onChange={(event) => update('title', event.currentTarget.value)}
            onBlur={() => touch('title')}
            className={cx(controlClass(errorOf('title')), 'h-12')}
          />
        )}
      </FieldShell>

      <FieldShell
        {...shell('description', idOf('description'), {
          counter: { count: characterCount(values.description, true), ...LISTING_LIMITS.description },
        })}
      >
        {(describedBy) => (
          <textarea
            id={idOf('description')}
            value={values.description}
            aria-invalid={Boolean(errorOf('description'))}
            aria-describedby={describedBy}
            onChange={(event) => update('description', event.currentTarget.value)}
            onBlur={() => touch('description')}
            className={cx(controlClass(errorOf('description')), 'min-h-44 resize-y py-3')}
          />
        )}
      </FieldShell>

      <FieldShell
        {...shell('highlights', idOf('highlights.0'), {
          helper: `${LISTING_LIMITS.highlights.min} to ${LISTING_LIMITS.highlights.max}, each up to ${LISTING_LIMITS.highlights.maxLength} characters.`,
          group: true,
        })}
      >
        {(describedBy) => (
          <Highlights
            values={values.highlights}
            addId={addHighlightId}
            idOf={(index) => idOf(`highlights.${index}`)}
            errorOf={(index) => errorOf(`highlights.${index}`)}
            describedBy={describedBy}
            onChange={(next) => update('highlights', next)}
            onBlur={() => touch('highlights')}
          />
        )}
      </FieldShell>

      <FieldPair>
        <FieldShell {...shell('category', idOf('category'), { paired: true })}>
          {(describedBy) => (
            <Select
              id={idOf('category')}
              value={values.category}
              error={errorOf('category')}
              describedBy={describedBy}
              onChange={(value) => update('category', value as ReviewValues['category'])}
              onBlur={() => touch('category')}
              placeholder="Choose a category"
              options={PRODUCT_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }))}
            />
          )}
        </FieldShell>
        <FieldShell {...shell('condition', idOf('condition'), { paired: true })}>
          {(describedBy) => (
            <Select
              id={idOf('condition')}
              value={values.condition}
              error={errorOf('condition')}
              describedBy={describedBy}
              onChange={(value) => update('condition', value as ReviewValues['condition'])}
              onBlur={() => touch('condition')}
              placeholder="Choose a condition"
              options={PRODUCT_CONDITIONS.map((value) => ({ value, label: CONDITION_LABELS[value] }))}
            />
          )}
        </FieldShell>
      </FieldPair>

      {(
        [
          ['brand', 'color'],
          ['material', 'size'],
        ] as const
      ).map((pair) => (
        <FieldPair key={pair.join('-')}>
          {pair.map((field) => (
            <FieldShell
              key={field}
              {...shell(field, idOf(field), {
                paired: true,
                helper: required.includes(field)
                  ? `Required for ${CATEGORY_LABELS[values.category as keyof typeof CATEGORY_LABELS].toLowerCase()}.`
                  : 'Optional.',
              })}
            >
              {(describedBy) => (
                <input
                  id={idOf(field)}
                  type="text"
                  autoComplete="off"
                  value={values[field]}
                  aria-invalid={Boolean(errorOf(field))}
                  aria-describedby={describedBy}
                  aria-required={required.includes(field) || undefined}
                  onChange={(event) => update(field, event.currentTarget.value)}
                  onBlur={() => touch(field)}
                  className={cx(controlClass(errorOf(field)), 'h-12')}
                />
              )}
            </FieldShell>
          ))}
        </FieldPair>
      ))}

      <FieldShell {...shell('tags', idOf('tags'))}>
        {(describedBy) => (
          <ChipInput
            id={idOf('tags')}
            labelledBy={`${idOf('tags')}-label`}
            values={values.tags}
            max={LISTING_LIMITS.tags.max}
            describedBy={describedBy}
            error={errorOf('tags')}
            onChange={(next) => update('tags', next)}
            onBlur={() => touch('tags')}
          />
        )}
      </FieldShell>

      <ActionBar status={reviewStatus(job.draft !== null, unchanged, open.length)} pending={pending} />
    </form>
  );
}

type ShellProps = {
  controlId: string;
  label: string;
  /** AI-generated and untouched, or changed by the admin; none when nothing was generated. */
  badge: 'ai' | 'edited' | null;
  prompts: readonly ListingUncertainty[];
  onConfirm: () => void;
  error?: string;
  /** The value is empty: confirming its uncertainty means leaving it so. */
  empty: boolean;
  /** The chosen category can't be listed without it. */
  required: boolean;
  helper?: string;
  counter?: { count: number; min?: number; max: number };
  /** A list of controls (highlights): the label names the group rather than one control. */
  group?: boolean;
  /** One of the two fields of a `FieldPair`: from 735 px its parts take the pair's shared rows. */
  paired?: boolean;
  children: (describedBy: string | undefined) => ReactNode;
};

/**
 * Two fields side by side from 735 px. Each field's label, prompt, control and footer are a subgrid of the
 * pair's four rows, so both controls start on the same line whatever prompt either column carries (a two-line
 * prompt beside a one-line one would otherwise set one control lower than the other).
 */
function FieldPair({ children }: { children: ReactNode }) {
  return <div className="grid gap-8 sm:grid-cols-2 sm:gap-y-0">{children}</div>;
}

/**
 * A review field (§10.9): a label row with the AI or Edited badge and the counter, the field's uncertainty
 * prompts, the control, then its error and helper, all linked to the control with `aria-describedby`.
 *
 * An uncertainty is confirmed with "Looks right", or "Leave empty" when there is no value, and not at all for
 * an empty field the category requires: only a value answers it. While the field shows an error the prompt
 * steps back to a quiet note under it ("The model noted: …"), so one control never carries two alerts, while
 * the uncertainty the action bar counts as open stays on the page, with the context for fixing the field. A
 * new value settles both.
 */
function FieldShell({
  controlId,
  label,
  badge,
  prompts,
  onConfirm,
  error,
  empty,
  required,
  helper,
  counter,
  group,
  paired = false,
  children,
}: ShellProps) {
  const labelId = `${controlId}-label`;
  const badgeId = `${controlId}-badge`;
  const helperId = `${controlId}-helper`;
  const counterId = `${controlId}-counter`;
  const promptIds = prompts.map((_, index) => `${controlId}-prompt-${index}`);
  const noting = error !== undefined && prompts.length > 0;
  const confirmText = empty ? (required ? null : 'Leave empty') : 'Looks right';
  // An error already says what the helper would ("Size is required for apparel."): one line, not two.
  const shownHelper = error ? undefined : helper;
  const outside =
    counter !== undefined && (counter.count > counter.max || counter.count < (counter.min ?? 0));
  const describedBy =
    [
      error && errorId(controlId),
      ...(noting ? promptIds : []),
      badge && badgeId,
      ...(noting ? [] : promptIds),
      counter && counterId,
      shownHelper && helperId,
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  const content = (
    <>
      <div className="flex min-h-6 items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {group ? (
            <p id={labelId} className="text-callout font-medium">
              {label}
            </p>
          ) : (
            <label id={labelId} htmlFor={controlId} className="text-callout font-medium">
              {label}
            </label>
          )}
          {badge && <FieldBadge id={badgeId} edited={badge === 'edited'} />}
        </div>
        {counter && (
          <span
            id={counterId}
            className={cx('text-footnote tabular-nums', outside ? 'text-danger' : 'text-label-secondary')}
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
      {/* Always four parts, so a paired field's subgrid rows line up with its neighbour's. */}
      <div className="flex flex-col">
        {prompts.length > 0 && !error && (
          // In a half-width column the action goes under the note, so neither is squeezed beside the other.
          // Beside a taller prompt in a pair, it fills the shared row, so the two read as one band.
          <div className="@container mt-2 flex flex-1 flex-col">
            <div className="flex flex-1 items-start gap-2 rounded-md bg-warning-tint py-2 pr-2 pl-3 animate-fade-in">
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning" />
              <div className="flex min-w-0 flex-1 flex-col items-start gap-1 @min-[26rem]:flex-row @min-[26rem]:justify-between @min-[26rem]:gap-2">
                <div className="min-w-0 text-callout text-label">
                  {prompts.map((prompt, index) => (
                    <p key={`${prompt.field}:${prompt.note}`} id={promptIds[index]}>
                      {prompt.note || UNCERTAINTY_FALLBACK}
                    </p>
                  ))}
                </div>
                {confirmText && (
                  <Button
                    variant="plain"
                    size="sm"
                    onClick={onConfirm}
                    // Every prompt's button reads the same: the field is part of its name (WCAG 2.4.6).
                    aria-label={`${confirmText}: ${label}`}
                    aria-describedby={promptIds.join(' ')}
                    className="-mb-1 -ml-3 shrink-0 @min-[26rem]:-my-1 @min-[26rem]:ml-0"
                  >
                    {confirmText}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="mt-2">{children(describedBy)}</div>
      <div>
        {error && (
          <p id={errorId(controlId)} className="mt-2 flex items-start gap-1.5 text-footnote text-danger">
            <CircleAlert size={16} className="mt-px shrink-0" />
            {error}
          </p>
        )}
        {noting && (
          // Under the error's text, past its icon.
          <div className="mt-1 pl-5.5 text-footnote text-label-secondary">
            {prompts.map((prompt, index) => (
              <p key={`${prompt.field}:${prompt.note}`} id={promptIds[index]}>
                The model noted: {prompt.note || 'Not visible in the photos.'}
              </p>
            ))}
          </div>
        )}
        {shownHelper && (
          <p id={helperId} className="mt-2 text-footnote text-label-secondary">
            {helper}
          </p>
        )}
      </div>
    </>
  );
  return group ? (
    <fieldset aria-labelledby={labelId} className="min-w-0">
      {content}
    </fieldset>
  ) : (
    <div className={paired ? 'sm:row-span-4 sm:grid sm:grid-rows-subgrid' : undefined}>{content}</div>
  );
}

/** "AI" with `Sparkles` until the admin changes the field, then "Edited" with `Pencil` (§9.24). */
function FieldBadge({ id, edited }: { id: string; edited: boolean }) {
  const Icon = edited ? Pencil : Sparkles;
  return (
    <span
      id={id}
      className="inline-flex h-5 items-center gap-1 rounded-full bg-fill-tertiary px-2 text-caption font-medium text-label"
    >
      <Icon size={14} strokeWidth={1.5} />
      {edited ? 'Edited' : 'AI'}
      <span className="sr-only">{edited ? ' by you' : '-generated from your photos'}</span>
    </span>
  );
}

function Select({
  id,
  value,
  error,
  describedBy,
  onChange,
  onBlur,
  placeholder,
  options,
}: {
  id: string;
  value: string;
  error: string | undefined;
  describedBy: string | undefined;
  onChange: (value: string) => void;
  onBlur: () => void;
  placeholder: string;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={onBlur}
        className={cx(controlClass(error), 'h-12 appearance-none pr-10')}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-label-secondary"
      />
    </div>
  );
}

/** Three to six highlights, each its own input, numbered, with remove buttons and "Add highlight". */
function Highlights({
  values,
  addId,
  idOf,
  errorOf,
  describedBy,
  onChange,
  onBlur,
}: {
  values: readonly string[];
  /** "Add highlight", where a list-level error takes focus when the list is empty. */
  addId: string;
  idOf: (index: number) => string;
  errorOf: (index: number) => string | undefined;
  describedBy: string | undefined;
  onChange: (values: string[]) => void;
  onBlur: () => void;
}) {
  const addRef = useRef<HTMLButtonElement>(null);
  const full = values.length >= LISTING_LIMITS.highlights.max;

  function add() {
    if (full) return;
    onChange([...values, '']);
    requestAnimationFrame(() => document.getElementById(idOf(values.length))?.focus());
  }

  function remove(index: number) {
    onChange(values.filter((_, at) => at !== index));
    announce(`Highlight ${index + 1} removed.`);
    requestAnimationFrame(() => {
      const next = document.getElementById(idOf(Math.min(index, values.length - 2)));
      (next ?? addRef.current)?.focus();
    });
  }

  return (
    <>
      <ol className="flex flex-col gap-2">
        {values.map((value, index) => {
          const error = errorOf(index);
          return (
            // Index keys: entries are positions in a list the admin edits in place.
            <li key={index} className="flex items-start gap-2">
              <span
                aria-hidden="true"
                className="mt-3.5 w-5 shrink-0 text-end text-footnote text-label-secondary tabular-nums"
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                {/* A textarea that grows with its text, so a 120-character highlight can be proofread whole
                    on a phone. A highlight is one line of the product page: Enter adds no line break, and a
                    pasted one becomes a space. */}
                <textarea
                  id={idOf(index)}
                  rows={1}
                  autoComplete="off"
                  aria-label={`Highlight ${index + 1}`}
                  aria-invalid={Boolean(error)}
                  aria-describedby={
                    [error && errorId(idOf(index)), index === 0 ? describedBy : undefined]
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  value={value}
                  onChange={(event) => {
                    const next = event.currentTarget.value.replace(/\r?\n/g, ' ');
                    onChange(values.map((entry, at) => (at === index ? next : entry)));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.preventDefault();
                  }}
                  onBlur={onBlur}
                  className={cx(controlClass(error), 'field-sizing-content min-h-12 resize-none py-2.5')}
                />
                {error && (
                  <p
                    id={errorId(idOf(index))}
                    className="mt-2 flex items-start gap-1.5 text-footnote text-danger"
                  >
                    <CircleAlert size={16} className="mt-px shrink-0" />
                    {error}
                  </p>
                )}
              </div>
              <IconButton
                label={`Remove highlight ${index + 1}`}
                icon={X}
                onClick={() => remove(index)}
                className="mt-0.5"
              />
            </li>
          );
        })}
      </ol>
      <Button
        ref={addRef}
        id={addId}
        variant="plain"
        size="sm"
        icon={Plus}
        disabled={full}
        onClick={add}
        className="mt-2 ml-5"
      >
        Add highlight
      </Button>
    </>
  );
}

/**
 * The error summary of a failed approve (§10.9, as checkout's, SD §8.3): a region named by its title and
 * described by its list that takes focus, so one focus event reads the count and every field to fix.
 */
function ErrorSummary({
  ref,
  keys,
  message,
  targetOf,
}: {
  ref: Ref<HTMLElement>;
  keys: readonly ErrorKey[];
  message: (key: ErrorKey) => string;
  /** The id each link focuses (`focusKeyOf`). */
  targetOf: (key: ErrorKey) => string;
}) {
  return (
    <section
      ref={ref}
      aria-labelledby="review-summary-title"
      aria-describedby="review-summary-list"
      tabIndex={-1}
      className="flex animate-fade-in items-start gap-3 rounded-md bg-danger-tint py-3 pr-4 pl-4"
    >
      <CircleX className="shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <h2 id="review-summary-title" className="text-headline">
          Fix {keys.length} {plural(keys.length, 'field', 'fields')} to publish
        </h2>
        <ul id="review-summary-list" className="mt-1 text-callout">
          {keys.map((key) => (
            <li key={key}>
              <a
                href={`#${targetOf(key)}`}
                onClick={(event) => {
                  const target = document.getElementById(targetOf(key));
                  if (!target) return;
                  event.preventDefault();
                  target.focus();
                }}
                className="inline-flex min-h-6 items-center text-label underline underline-offset-2"
              >
                {message(key)}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * The review's sticky action bar (§10.9): `material-bar` along the bottom, 72 px plus the safe area, with the
 * review's state in `label` (§2.5) and the one filled action. Its content lines up with the page's column.
 */
function ActionBar({ status, pending }: { status: string; pending: boolean }) {
  return (
    <div
      data-bottom-bar
      className="material-bar fixed inset-x-0 bottom-0 z-(--z-sticky) border-separator border-t pb-[env(safe-area-inset-bottom)]"
    >
      <div className="page-full md:grid md:grid-cols-[15rem_minmax(0,1fr)] md:gap-x-(--grid-gap)">
        <div className="flex h-18 items-center justify-between gap-4 md:col-start-2">
          <p className="min-w-0 text-footnote text-label">{status}</p>
          <Button type="submit" loading={pending} reserve={['Approve and publish', 'Publishing…']}>
            {pending ? 'Publishing…' : 'Approve and publish'}
          </Button>
        </div>
      </div>
    </div>
  );
}
