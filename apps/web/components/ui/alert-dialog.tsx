'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';

type AlertDialogProps = {
  open: boolean;
  /** Runs the safe action. Esc chooses it; clicking the backdrop does nothing (§9.14). */
  onCancel: () => void;
  title: string;
  description: ReactNode;
  /**
   * The actions, primary first. The safe one carries `data-autofocus` and takes initial focus, so Enter never
   * commits by accident: "Stay" in a destructive confirmation, "Cancel" in any other.
   */
  children: ReactNode;
};

/**
 * A confirmation on a native modal <dialog> (§9.14): `showModal()` brings the focus trap, the inert
 * background and the top layer, and closing returns focus to the opener. It fades and scales in through the
 * CSS dialog motion of base.css.
 */
export function AlertDialog({ open, onCancel, title, description, children }: AlertDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        // The parent owns `open`; it closes the dialog by running the safe action.
        event.preventDefault();
        onCancel();
      }}
      className="m-auto w-[calc(100%-(--spacing(10)))] max-w-100 rounded-xl bg-surface p-6 text-label elevation-3"
    >
      <h2 id={titleId} className="text-title-3">
        {title}
      </h2>
      <div id={descriptionId} className="mt-2 text-body text-label-secondary">
        {description}
      </div>
      <div className="mt-6 flex flex-col gap-3 *:w-full sm:flex-row sm:justify-end sm:*:w-auto">
        {children}
      </div>
    </dialog>
  );
}
