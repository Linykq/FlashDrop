'use client';

import type { LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { cx } from '../../lib/cx';

export type SegmentedOption<T extends string> = {
  value: T;
  /** At most 12 characters, so equal-width segments fit (§9.3). */
  label: string;
  icon?: LucideIcon;
};

type SegmentedControlProps<T extends string> = {
  /** Names the group for assistive technology; visually hidden. */
  legend: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
};

/**
 * Picks one of 2 to 5 values that filter or switch a view (§9.3): a native radio group, so Tab enters it and
 * the arrow keys move and select. The thumb is one element under the equal-width segments that slides to
 * the checked one with a CSS transition, which, unlike a shared-layout spring, costs no JavaScript: the
 * control sits in the footer of every page, inside the first-load budget (§14).
 */
export function SegmentedControl<T extends string>({
  legend,
  options,
  value,
  onChange,
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  const id = useId();
  const checkedIndex = options.findIndex((option) => option.value === value);
  return (
    <fieldset className={className}>
      <legend className="sr-only">{legend}</legend>
      <div
        className={cx(
          'relative grid auto-cols-fr grid-flow-col rounded-full bg-fill-tertiary p-0.5',
          size === 'sm' ? 'h-7' : 'h-9',
        )}
      >
        {checkedIndex >= 0 && (
          <span
            aria-hidden="true"
            // The transparent border is painted in forced-colours mode, where the fill and shadow are not.
            className="absolute inset-y-0.5 left-0.5 rounded-full border border-transparent bg-thumb elevation-thumb motion-safe:transition-transform motion-safe:duration-250 motion-safe:ease-out"
            style={{
              width: `calc((100% - 4px) / ${options.length})`,
              transform: `translateX(${checkedIndex * 100}%)`,
            }}
          />
        )}
        {options.map(({ value: optionValue, label, icon: Icon }) => {
          const checked = optionValue === value;
          return (
            <label
              key={optionValue}
              className={cx(
                'relative flex cursor-pointer select-none items-center justify-center gap-1.5 rounded-full text-label',
                size === 'sm' ? 'px-3 text-footnote' : 'px-4 text-callout',
                checked ? 'font-semibold' : 'font-medium',
                // The radio is visually hidden, so its segment draws the standard focus ring.
                'has-focus-visible:outline-3 has-focus-visible:outline-focus has-focus-visible:outline-offset-2',
              )}
            >
              <input
                type="radio"
                name={id}
                value={optionValue}
                checked={checked}
                onChange={() => onChange(optionValue)}
                className="sr-only"
              />
              {Icon && <Icon size={16} className="shrink-0" />}
              <span className="whitespace-nowrap">{label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
