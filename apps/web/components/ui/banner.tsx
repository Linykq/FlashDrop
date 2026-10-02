import { CircleCheck, CircleX, Info, type LucideIcon, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { IconButton } from './icon-button';

export type BannerTone = 'info' | 'success' | 'warning' | 'danger';

const tones: Record<BannerTone, { icon: LucideIcon; surface: string; ink: string }> = {
  info: { icon: Info, surface: 'bg-accent-tint', ink: 'text-accent-label' },
  success: { icon: CircleCheck, surface: 'bg-success-tint', ink: 'text-success' },
  warning: { icon: TriangleAlert, surface: 'bg-warning-tint', ink: 'text-warning' },
  danger: { icon: CircleX, surface: 'bg-danger-tint', ink: 'text-danger' },
};

type BannerProps = {
  tone: BannerTone;
  /** Replaces the tone's icon where §7 has a specific glyph for the message (`WifiOff` for paused updates). */
  icon?: LucideIcon;
  title?: string;
  children: ReactNode;
  /** A plain sm button or a link: the next step. */
  action?: ReactNode;
  /** Shows a dismiss button. Only from a Client Component, which owns the banner's visibility. */
  onDismiss?: () => void;
  /**
   * Only for an error caused by the user's last action (§9.15). Every other banner is static: it appears on
   * load or in a reserved slot and is read in document order.
   */
  alert?: boolean;
  className?: string;
};

/** An inline message at the top of the region it is about: a page, a card or a form. */
export function Banner({
  tone,
  icon,
  title,
  children,
  action,
  onDismiss,
  alert = false,
  className,
}: BannerProps) {
  const { surface, ink } = tones[tone];
  const Icon = icon ?? tones[tone].icon;
  return (
    <div
      role={alert ? 'alert' : undefined}
      className={cx(
        'flex items-start gap-3 rounded-md py-3 pl-4',
        onDismiss ? 'pr-2' : 'pr-4',
        surface,
        className,
      )}
    >
      <Icon className={cx('shrink-0', ink)} />
      <div className="min-w-0 flex-1">
        {title && <p className="text-headline text-label">{title}</p>}
        <div className="text-callout text-label">{children}</div>
        {action && <div className="mt-2">{action}</div>}
      </div>
      {onDismiss && <IconButton label="Dismiss" icon={X} size="sm" className="-my-1" onClick={onDismiss} />}
    </div>
  );
}
