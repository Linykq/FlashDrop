import { type ComponentProps, type ReactNode, useId } from 'react';
import { cx } from '../../lib/cx';

type RadioCardProps = Omit<
  ComponentProps<'input'>,
  'type' | 'className' | 'children' | 'aria-labelledby' | 'aria-describedby'
> & {
  title: string;
  description?: string;
  /** An avatar or a pill at the card's end. */
  trailing?: ReactNode;
  className?: string;
};

/**
 * A choice in a native radio group, drawn as a card (§9.5): the whole card is the label, so a click anywhere
 * picks it, and the group's arrow keys come with the native radios. The radio is named by the title alone and
 * described by the description, so a screen reader says "Card ending 4242, radio button, 1 of 4" before the
 * detail. Checked, the 1 px border and an inset 1 px ring read as 2 px without moving the layout; the card
 * draws the focus ring for its radio. In forced colours the checked radio's border thickens into a ring.
 */
export function RadioCard({ title, description, trailing, className, ...input }: RadioCardProps) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <label
      className={cx(
        'flex min-h-14 cursor-pointer items-center gap-3 rounded-md border border-control bg-surface px-4 py-3',
        'transition-colors duration-200 ease-standard hover:bg-fill-quaternary',
        'has-checked:border-accent has-checked:ring-1 has-checked:ring-accent has-checked:ring-inset',
        'has-focus-visible:outline-3 has-focus-visible:outline-focus has-focus-visible:outline-offset-2',
        className,
      )}
    >
      <span className="grid size-5.5 shrink-0 place-items-center self-start">
        <input
          {...input}
          type="radio"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          className="peer col-start-1 row-start-1 size-5.5 appearance-none rounded-full border border-control bg-surface checked:border-accent checked:bg-accent focus-visible:outline-none forced-colors:checked:border-7"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none col-start-1 row-start-1 size-2 rounded-full bg-label-on-color opacity-0 peer-checked:opacity-100"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span id={titleId} className="block text-body font-medium">
          {title}
        </span>
        {description && (
          <span id={descriptionId} className="mt-0.5 block text-footnote text-label-secondary">
            {description}
          </span>
        )}
      </span>
      {trailing}
    </label>
  );
}
