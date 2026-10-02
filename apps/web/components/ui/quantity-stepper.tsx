'use client';

import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { cx } from '../../lib/cx';
import { IconButton } from './icon-button';

type QuantityStepperProps = {
  value: number;
  /** The drop's per-person limit. With a limit of 1 there is nothing to choose and nothing renders (§9.6). */
  max: number;
  onChange: (value: number) => void;
  /**
   * `md` is the 44 px pill; `lg` is 56 px, beside an lg Buy button, so the two pills share their top and
   * bottom edges. Its 44 px buttons stay inset, concentric with its rounded ends (§9.6).
   */
  size?: 'md' | 'lg';
};

/**
 * Minus, the quantity, plus, in one pill. The value is announced politely as it changes, and rises into
 * place once the buyer changed it (a CSS keyframe on the remounted number, so the stepper needs no animation
 * library).
 */
export function QuantityStepper({ value, max, onChange, size = 'md' }: QuantityStepperProps) {
  // Set by the buttons only, so the first render (and hydration) shows the number without motion. It is
  // batched with the parent's update from the same click, so it costs no extra render.
  const [changed, setChanged] = useState(false);
  if (max < 2) return null;

  function step(next: number): void {
    setChanged(true);
    onChange(next);
  }

  return (
    <fieldset
      className={cx(
        'inline-flex shrink-0 items-center rounded-full border border-transparent bg-fill-tertiary',
        size === 'lg' ? 'h-14 px-1.5' : 'h-11',
      )}
    >
      <legend className="sr-only">Quantity</legend>
      <IconButton
        label="Decrease quantity"
        icon={Minus}
        smallIcon
        disabled={value <= 1}
        onClick={() => step(value - 1)}
      />
      <output
        aria-live="polite"
        className={cx(
          'inline-grid justify-items-center text-headline tabular-nums',
          size === 'lg' ? 'min-w-10' : 'min-w-8',
        )}
      >
        <span key={value} className={cx(changed && 'motion-safe:animate-number-in')}>
          {value}
        </span>
      </output>
      <IconButton
        label="Increase quantity"
        icon={Plus}
        smallIcon
        disabled={value >= max}
        onClick={() => step(value + 1)}
      />
    </fieldset>
  );
}
