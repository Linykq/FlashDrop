import Link from 'next/link';
import type { ComponentProps, ComponentType, MouseEvent, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Spinner } from './spinner';

export type ButtonVariant = 'filled' | 'tinted' | 'gray' | 'plain';
export type ButtonSize = 'sm' | 'md' | 'lg';

/** A Lucide icon, or a component wrapping one (the Buy button's animated check), sized by the button. */
export type ButtonIcon = ComponentType<{ size: number }>;

/**
 * `destructive` swaps the text to `danger` (and a tinted fill to `danger-tint`) for "Leave" and "End drop".
 * `neutral` makes a plain button `label`, which is required on `material-bar` and `material-thick` (§2.5).
 * Filled buttons have no tones: one primary action per region, always the accent.
 */
type Appearance =
  | { variant?: 'filled'; tone?: 'default' }
  | { variant: 'tinted' | 'gray'; tone?: 'default' | 'destructive' }
  | { variant: 'plain'; tone?: 'default' | 'destructive' | 'neutral' };

type Tone = 'default' | 'destructive' | 'neutral';

/** A variant's rest colours, and its hover and pressed feedback, which a busy button doesn't give. */
type Colors = { rest: string; feedback: string };

const colorClass: { [V in ButtonVariant]: { default: Colors } & Partial<Record<Tone, Colors>> } = {
  filled: {
    default: {
      rest: 'bg-accent text-label-on-color',
      feedback: 'hover:bg-accent-hover active:bg-accent-pressed',
    },
  },
  tinted: {
    default: {
      rest: 'bg-accent-tint text-accent-label',
      feedback: 'hover:bg-accent-tint-hover active:bg-accent-tint-hover',
    },
    destructive: {
      rest: 'bg-danger-tint text-danger',
      feedback: 'hover:bg-danger-tint-hover active:bg-danger-tint-hover',
    },
  },
  gray: {
    default: { rest: 'bg-fill-tertiary text-label', feedback: 'hover:bg-fill-secondary active:bg-fill' },
    destructive: { rest: 'bg-fill-tertiary text-danger', feedback: 'hover:bg-fill-secondary active:bg-fill' },
  },
  plain: {
    default: { rest: 'text-accent-label', feedback: 'hover:bg-fill-quaternary active:bg-fill-tertiary' },
    destructive: { rest: 'text-danger', feedback: 'hover:bg-fill-quaternary active:bg-fill-tertiary' },
    neutral: { rest: 'text-label', feedback: 'hover:bg-fill-quaternary active:bg-fill-tertiary' },
  },
};

// Disabled controls keep no hover or pressed feedback: nothing happens when they are activated. A loading
// control is not disabled: it keeps its colours (and their contrast) and shows the spinner (§9.0).
const disabledClass: Record<ButtonVariant, string> = {
  filled: 'bg-fill-tertiary text-label-tertiary',
  tinted: 'bg-fill-tertiary text-label-tertiary',
  gray: 'bg-fill-tertiary text-label-tertiary',
  plain: 'text-label-tertiary',
};

// Height, label style and gap per size; the padding is smaller on the side that holds an icon (§9.1).
const sizeClass: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 text-footnote font-medium',
  md: 'h-11 gap-1.5 text-callout font-medium',
  lg: 'h-14 gap-2 text-body font-medium',
};
const paddingStart: Record<ButtonSize, [plain: string, icon: string]> = {
  sm: ['pl-3', 'pl-2.5'],
  md: ['pl-5', 'pl-4'],
  lg: ['pl-7', 'pl-6'],
};
const paddingEnd: Record<ButtonSize, [plain: string, icon: string]> = {
  sm: ['pr-3', 'pr-2.5'],
  md: ['pr-5', 'pr-4'],
  lg: ['pr-7', 'pr-6'],
};
const iconSize: Record<ButtonSize, 16 | 20> = { sm: 16, md: 16, lg: 20 };

type StyleProps = Appearance & {
  size?: ButtonSize;
  /** `rounded` is for full-width buttons in checkout, dialogs and the login card. */
  shape?: 'pill' | 'rounded';
  fullWidth?: boolean;
  icon?: ButtonIcon;
  trailingIcon?: ButtonIcon;
  /**
   * Every label this button can show ("Buy 2", "Reserving…", "Reserved"). The label slot takes the width of
   * the widest, so swapping labels never moves the layout (§9.0 loading state).
   */
  reserve?: readonly string[];
  className?: string;
  children: ReactNode;
};

type InteractionState = 'idle' | 'disabled' | 'loading';

function buttonClass(
  { variant = 'filled', tone = 'default', size = 'md', shape = 'pill', fullWidth, trailingIcon }: StyleProps,
  { state, leading }: { state: InteractionState; leading: boolean },
): string {
  const colors = colorClass[variant][tone] ?? colorClass[variant].default;
  return cx(
    // The transparent border is painted in forced-colours mode, so the button keeps its shape there (§13.1).
    'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap border border-transparent',
    // Pressed colour applies at once and releases in 100 ms; hover eases in over 200 ms (§6.4).
    'transition-colors duration-100 ease-standard hover:duration-200 active:duration-0',
    sizeClass[size],
    paddingStart[size][leading ? 1 : 0],
    paddingEnd[size][trailingIcon ? 1 : 0],
    shape === 'pill' ? 'rounded-full' : 'rounded-md',
    fullWidth && 'w-full',
    state === 'disabled' ? disabledClass[variant] : colors.rest,
    state === 'idle' && colors.feedback,
    state === 'disabled' && 'cursor-default',
    state === 'loading' && 'cursor-progress',
  );
}

function Content({
  size = 'md',
  icon: Icon,
  trailingIcon: TrailingIcon,
  loading,
  reserve,
  children,
}: Pick<StyleProps, 'size' | 'icon' | 'trailingIcon' | 'reserve' | 'children'> & { loading: boolean }) {
  const px = iconSize[size];
  return (
    <>
      {loading ? <Spinner size={px} /> : Icon && <Icon size={px} />}
      {/* The label hugs its icon: the slot's spare width (§9.0 reserve) goes on the side away from it. */}
      <span
        className={cx(
          'grid',
          Icon || loading
            ? 'justify-items-start'
            : TrailingIcon
              ? 'justify-items-end'
              : 'justify-items-center',
        )}
      >
        <span className="col-start-1 row-start-1">{children}</span>
        {reserve?.map((label) => (
          <span key={label} aria-hidden="true" className="invisible col-start-1 row-start-1">
            {label}
          </span>
        ))}
      </span>
      {TrailingIcon && <TrailingIcon size={px} />}
    </>
  );
}

type ButtonProps = StyleProps &
  Omit<ComponentProps<'button'>, 'className' | 'children' | 'disabled'> & {
    /** Rendered with `aria-disabled`, never `disabled`, so the button stays focusable and can explain itself. */
    disabled?: boolean;
    /** Spinner and `aria-busy`; pass the progressive label ("Reserving…") as children. */
    loading?: boolean;
  };

/**
 * A button that acts (§9.1). A button that navigates is a `ButtonLink`.
 *
 * Disabled and loading buttons ignore activation in `onClick`. A handler can only come from a Client
 * Component, so a submit button without one relies on its form's own pending guard.
 */
export function Button(props: ButtonProps) {
  const {
    variant: _variant,
    tone: _tone,
    size,
    shape: _shape,
    fullWidth: _fullWidth,
    icon,
    trailingIcon,
    reserve,
    className,
    children,
    disabled = false,
    loading = false,
    type = 'button',
    onClick,
    ...rest
  } = props;
  const state: InteractionState = disabled ? 'disabled' : loading ? 'loading' : 'idle';
  return (
    <button
      {...rest}
      type={type}
      aria-disabled={disabled || undefined}
      aria-busy={loading || undefined}
      onClick={
        onClick &&
        ((event: MouseEvent<HTMLButtonElement>) => {
          if (state !== 'idle') {
            event.preventDefault();
            return;
          }
          onClick(event);
        })
      }
      className={cx(buttonClass(props, { state, leading: loading || icon !== undefined }), className)}
    >
      <Content size={size} icon={icon} trailingIcon={trailingIcon} loading={loading} reserve={reserve}>
        {children}
      </Content>
    </button>
  );
}

type ButtonLinkProps = StyleProps & Omit<ComponentProps<typeof Link>, 'className' | 'children'>;

/** A link styled as a button ("Watch live", "Try again" to the product page). */
export function ButtonLink(props: ButtonLinkProps) {
  const {
    variant: _variant,
    tone: _tone,
    size,
    shape: _shape,
    fullWidth: _fullWidth,
    icon,
    trailingIcon,
    reserve,
    className,
    children,
    ...rest
  } = props;
  return (
    <Link
      {...rest}
      className={cx(buttonClass(props, { state: 'idle', leading: icon !== undefined }), className)}
    >
      <Content size={size} icon={icon} trailingIcon={trailingIcon} loading={false} reserve={reserve}>
        {children}
      </Content>
    </Link>
  );
}
