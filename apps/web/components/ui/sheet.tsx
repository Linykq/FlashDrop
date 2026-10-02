'use client';

import { m, useDragControls, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { type ReactNode, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { exitTransition, spring } from '../../lib/motion';
import { useMediaQuery } from '../../lib/use-media-query';
import { IconButton } from './icon-button';
import { MotionProvider } from './motion-provider';

type SheetProps = {
  open: boolean;
  /** Called once the sheet has closed, by any route: close button, Esc, backdrop or drag. */
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Actions, on a sticky `material-bar` footer. */
  footer?: ReactNode;
  /** `false` while a form inside has unsaved changes: a backdrop click then does nothing (§9.14). */
  dismissible?: boolean;
};

type Phase = 'closed' | 'open' | 'closing';

/**
 * Bigger modal content (§9.14), on a native <dialog data-sheet>. From 735 px it is a centred dialog with the
 * CSS dialog motion. Below, it is a bottom sheet whose panel slides with a spring and can be dragged down by
 * its header; `close()` runs only after the panel's exit, because closing first would remove the panel before
 * it could leave. The close button is always there as the non-drag alternative (WCAG 2.5.7).
 */
export function Sheet({ open, onClose, title, children, footer, dismissible = true }: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const phone = useMediaQuery('(width < 735px)');
  const reduceMotion = useReducedMotion() ?? false;
  const dragControls = useDragControls();
  const [phase, setPhase] = useState<Phase>('closed');
  // Under reduced motion the phone panel appears and leaves in place while its backdrop fades (§6.5).
  const slides = phone && !reduceMotion;

  function finishClose(): void {
    const dialog = dialogRef.current;
    dialog?.removeAttribute('data-closing');
    if (dialog?.open) dialog.close();
    setPhase('closed');
    onClose();
  }

  function requestClose(): void {
    if (phase !== 'open') return;
    if (!slides) {
      finishClose();
      return;
    }
    // Starts the backdrop's 200 ms fade (base.css) while the panel slides out.
    dialogRef.current?.setAttribute('data-closing', '');
    setPhase('closing');
  }

  // The parent closed the sheet: leave the same way as any other close.
  const closeForParent = useEffectEvent(requestClose);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setPhase('open');
      dialog
        .querySelector<HTMLElement>('[data-autofocus], input:not([type="hidden"]), select, textarea')
        ?.focus();
    } else if (!open && dialog.open) {
      closeForParent();
    }
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only detects the backdrop; Esc is the keyboard path.
    <dialog
      ref={dialogRef}
      data-sheet
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      // A browser may still force-close after repeated Esc presses; keep the state and the parent in step.
      onClose={() => {
        if (phase !== 'closed') finishClose();
      }}
      onClick={(event) => {
        // Clicks on the backdrop target the <dialog> itself; the panel covers the whole dialog box.
        if (event.target === event.currentTarget && dismissible) requestClose();
      }}
      className="mt-auto mb-0 w-full max-w-none overflow-visible bg-transparent text-label sm:m-auto sm:w-[calc(100%-(--spacing(10)))] sm:max-w-140"
    >
      <MotionProvider>
        <m.div
          ref={panelRef}
          initial={false}
          animate={{ y: slides && phase !== 'open' ? '100%' : 0 }}
          transition={phase === 'closing' ? exitTransition : spring.smooth}
          onAnimationComplete={() => {
            if (phase === 'closing') finishClose();
          }}
          drag={slides ? 'y' : false}
          dragListener={false}
          dragControls={dragControls}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 1 }}
          onDragEnd={(_, info) => {
            const height = panelRef.current?.offsetHeight ?? 0;
            if (info.velocity.y > 500 || info.offset.y > height * 0.3) requestClose();
          }}
          className="flex max-h-[92dvh] flex-col overflow-clip rounded-t-xl bg-surface pb-[env(safe-area-inset-bottom)] elevation-3 sm:max-h-[85dvh] sm:rounded-xl sm:pb-0"
        >
          <div
            className="shrink-0 px-5 pt-1.5 pb-3 max-sm:touch-none sm:px-6 sm:pt-5"
            onPointerDown={(event) => {
              if (slides) dragControls.start(event);
            }}
          >
            <div aria-hidden="true" className="mx-auto h-1.25 w-9 rounded-full bg-fill sm:hidden" />
            <div className="mt-2.5 flex items-center justify-between gap-4 sm:mt-0">
              <h2 id={titleId} className="text-title-2">
                {title}
              </h2>
              <IconButton label="Close" icon={X} variant="gray" size="sm" onClick={requestClose} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 sm:px-6">
            {children}
          </div>
          {footer && (
            <div className="material-bar flex shrink-0 justify-end gap-3 border-separator border-t px-5 py-4 sm:px-6">
              {footer}
            </div>
          )}
        </m.div>
      </MotionProvider>
    </dialog>
  );
}
