'use client';

import { lazy, Suspense, useSyncExternalStore } from 'react';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export type ToastOptions = {
  message: string;
  tone?: ToastTone;
  action?: { label: string; onAction: () => void };
};

export type ToastEntry = ToastOptions & { id: number };

const MAX_TOASTS = 3;

let toasts: readonly ToastEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const NO_TOASTS: readonly ToastEntry[] = [];

/**
 * Confirms a finished action that needs no response ("Published", "1 minute added"), §9.15. Never for errors
 * that need action, and never the only place a piece of information appears: a toast leaves after 5 s.
 */
export function toast(options: ToastOptions): void {
  toasts = [...toasts, { ...options, id: nextId++ }].slice(-MAX_TOASTS);
  emit();
}

function dismiss(id: number): void {
  toasts = toasts.filter((entry) => entry.id !== id);
  emit();
}

// Fetched with the first toast: most pages never show one, and its animation code is not small.
const ToastStack = lazy(() => import('./toast-stack'));

/**
 * The toast stack, bottom centre above the safe area and any sticky bottom bar. The region is always in the
 * DOM (`role="status"`), so each new toast is announced politely. Once the stack has loaded it stays
 * mounted, so a toast leaving still plays its exit.
 */
export function ToastRegion() {
  const entries = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => NO_TOASTS,
  );
  const shown = useSyncExternalStore(
    subscribe,
    () => nextId > 1,
    () => false,
  );
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+var(--bottom-bar-height)+--spacing(4))] z-(--z-toast) flex flex-col items-center gap-2 px-5"
    >
      {shown && (
        <Suspense fallback={null}>
          <ToastStack entries={entries} onDismiss={dismiss} />
        </Suspense>
      )}
    </div>
  );
}
