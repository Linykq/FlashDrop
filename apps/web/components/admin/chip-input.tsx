'use client';

import { X } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { cx } from '../../lib/cx';
import { announce } from '../ui/announcer';
import { errorId } from '../ui/text-field';

type ChipInputProps = {
  id: string;
  /** Read with the input; the visible label sits in the field's own label row. */
  labelledBy: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  max: number;
  /** Ids of whatever else describes the input: the uncertainty prompt, the helper. */
  describedBy?: string;
  error?: string;
  onBlur?: () => void;
};

/**
 * Tags as chips (design system §9.28): Enter or a comma adds the input's text, Backspace in an empty input
 * removes the last chip, and each chip has its own remove button. Every change is announced politely and
 * focus stays in the input. At the limit the input is `aria-disabled` and says so. Case-insensitive repeats
 * are skipped, as `ListingDraft`'s repair would drop them anyway.
 */
export function ChipInput({
  id,
  labelledBy,
  values,
  onChange,
  max,
  describedBy,
  error,
  onBlur,
}: ChipInputProps) {
  const [text, setText] = useState('');
  const full = values.length >= max;

  function add(): boolean {
    const tag = text.replace(/\s+/gu, ' ').trim().replace(/,$/, '');
    if (tag === '' || full) return false;
    setText('');
    if (values.some((value) => value.toLowerCase() === tag.toLowerCase())) return true;
    onChange([...values, tag]);
    announce(`Added tag ${tag}.`);
    return true;
  }

  function remove(index: number) {
    const tag = values[index];
    if (tag === undefined) return;
    onChange(values.filter((_, at) => at !== index));
    announce(`Removed tag ${tag}.`);
    document.getElementById(id)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      // Enter must never submit the review form from here.
      event.preventDefault();
      add();
    } else if (event.key === 'Backspace' && text === '' && values.length > 0) {
      event.preventDefault();
      remove(values.length - 1);
    }
  }

  const limitId = `${id}-limit`;
  return (
    <div>
      <div
        className={cx(
          'flex min-h-14 flex-wrap items-center gap-1.5 rounded-md border bg-surface px-3 py-2.5',
          'has-[input:focus-visible]:outline-3 has-[input:focus-visible]:outline-focus has-[input:focus-visible]:outline-offset-2',
          'transition-colors duration-200 ease-standard',
          error ? 'border-danger' : 'border-control hover:border-label-secondary',
        )}
      >
        {values.length > 0 && (
          <ul aria-label="Tags" className="contents">
            {values.map((tag, index) => (
              <li
                key={tag}
                className="inline-flex h-7 items-center gap-0.5 rounded-full bg-fill-tertiary pr-0.5 pl-2.5 text-footnote text-label"
              >
                {tag}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => remove(index)}
                  className="inline-flex size-6 items-center justify-center rounded-full text-label transition-colors duration-100 ease-standard hover:bg-fill-quaternary hover:duration-200 active:bg-fill-tertiary"
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          id={id}
          type="text"
          value={text}
          autoComplete="off"
          enterKeyHint="done"
          aria-labelledby={labelledBy}
          aria-invalid={Boolean(error)}
          aria-describedby={[error && errorId(id), describedBy, limitId].filter(Boolean).join(' ')}
          aria-disabled={full || undefined}
          readOnly={full}
          onChange={(event) => setText(event.currentTarget.value.replace(/,/g, ''))}
          onKeyDown={onKeyDown}
          onBlur={() => {
            add();
            onBlur?.();
          }}
          className="h-8 min-w-30 flex-1 bg-transparent px-1 text-body text-label outline-none"
        />
      </div>
      <p id={limitId} className="mt-2 text-footnote text-label-secondary tabular-nums">
        {full ? `${max} of ${max} tags` : 'Press Enter or type a comma to add a tag.'}
      </p>
    </div>
  );
}
