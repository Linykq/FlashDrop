'use client';

import { AnimatePresence, m } from 'framer-motion';
import { CircleCheck, CircleX, Info, type LucideIcon, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../../lib/cx';
import { exitTransition, spring } from '../../lib/motion';
import { Button } from './button';
import { IconButton } from './icon-button';
import { MotionProvider } from './motion-provider';
import type { ToastEntry, ToastTone } from './toast';

const VISIBLE_MS = 5000;

const toneIcon: Record<ToastTone, { icon: LucideIcon; className: string }> = {
  info: { icon: Info, className: 'text-accent-label' },
  success: { icon: CircleCheck, className: 'text-success' },
  warning: { icon: TriangleAlert, className: 'text-warning' },
  danger: { icon: CircleX, className: 'text-danger' },
};

type ToastStackProps = {
  entries: readonly ToastEntry[];
  onDismiss: (id: number) => void;
};

/**
 * The animated toasts (§6.4: rise 16 px with the `smooth` spring, the stack reflowing as one leaves). Loaded
 * with the first toast, so the animation code stays out of every page's first load (§14).
 */
export default function ToastStack({ entries, onDismiss }: ToastStackProps) {
  return (
    <MotionProvider>
      <AnimatePresence>
        {entries.map((entry) => (
          <ToastCard key={entry.id} entry={entry} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </MotionProvider>
  );
}

function ToastCard({ entry, onDismiss }: { entry: ToastEntry; onDismiss: (id: number) => void }) {
  const { icon: Icon, className } = toneIcon[entry.tone ?? 'success'];
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(VISIBLE_MS);
  const paused = hovered || focused;

  // The 5 s run only while the toast is neither hovered nor focused (WCAG 2.2.1); a pause keeps what is left.
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(entry.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [paused, entry.id, onDismiss]);

  return (
    <m.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8, transition: exitTransition }}
      transition={spring.smooth}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      className={cx(
        'material-thick pointer-events-auto flex w-full max-w-105 items-center gap-3 rounded-lg py-3 elevation-2',
        entry.action ? 'pr-2 pl-4' : 'px-4',
      )}
    >
      <Icon className={cx('shrink-0', className)} />
      <p className="min-w-0 flex-1 text-callout text-label">{entry.message}</p>
      {entry.action && (
        <>
          <Button
            variant="gray"
            size="sm"
            onClick={() => {
              entry.action?.onAction();
              onDismiss(entry.id);
            }}
          >
            {entry.action.label}
          </Button>
          <IconButton label="Dismiss" icon={X} size="sm" onClick={() => onDismiss(entry.id)} />
        </>
      )}
    </m.div>
  );
}
