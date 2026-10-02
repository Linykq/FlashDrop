import type { LucideIcon } from 'lucide-react';
import type { ComponentProps, MouseEvent } from 'react';
import { cx } from '../../lib/cx';

export type IconButtonVariant = 'gray' | 'plain' | 'overlay';

const variantClass: Record<IconButtonVariant, string> = {
  gray: 'bg-fill-tertiary text-label hover:bg-fill-secondary active:bg-fill',
  plain: 'text-label hover:bg-fill-quaternary active:bg-fill-tertiary',
  // Only on `material-overlay`, where `label` is white: a white wash on hover and press (§9.2).
  overlay: 'text-label hover:bg-label/16 active:bg-label/24',
};

type IconButtonProps = Omit<
  ComponentProps<'button'>,
  'className' | 'children' | 'disabled' | 'aria-label'
> & {
  /** The accessible name; icon-only buttons have no other text. */
  label: string;
  icon: LucideIcon;
  variant?: IconButtonVariant;
  /** 32 px (icon 16) for dense spots; 44 px (icon 20) everywhere else. */
  size?: 'sm' | 'md';
  /** A 16 px icon in a 44 px button, where the button sits inside a control (the quantity stepper). */
  smallIcon?: boolean;
  /** Toggle state (mute, captions, pause updates), exposed as `aria-pressed`. */
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
};

/** A circular icon-only button (§9.2). Disabled ones stay focusable and ignore activation in `onClick`. */
export function IconButton({
  label,
  icon: Icon,
  variant = 'plain',
  size = 'md',
  smallIcon = false,
  pressed,
  disabled = false,
  type = 'button',
  onClick,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      onClick={
        onClick &&
        ((event: MouseEvent<HTMLButtonElement>) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          onClick(event);
        })
      }
      className={cx(
        // The transparent border is painted in forced-colours mode, so the circle keeps its shape (§13.1).
        'inline-flex shrink-0 items-center justify-center rounded-full border border-transparent',
        'transition-colors duration-100 ease-standard hover:duration-200 active:duration-0',
        size === 'sm' ? 'size-8' : 'size-11',
        disabled ? 'cursor-default text-label-tertiary' : variantClass[variant],
        className,
      )}
    >
      <Icon size={size === 'sm' || smallIcon ? 16 : 20} />
    </button>
  );
}
