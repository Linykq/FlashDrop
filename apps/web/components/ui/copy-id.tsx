'use client';

import { Copy } from 'lucide-react';
import { IconButton } from './icon-button';
import { toast } from './toast';

type CopyTextProps = {
  text: string;
  /** The button's name: "Copy order id". */
  label: string;
  /** The toasts after a copy and after a refused one. */
  done: string;
  failed: string;
};

/**
 * Copies `text` from a 32 px icon button. The button is pulled out by most of its padding, so the glyph lines
 * up with the values above and below.
 */
export function CopyText({ text, label, done, failed }: CopyTextProps) {
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast({ message: done });
    } catch {
      // Clipboard access refused (an insecure origin, a denied permission): say so rather than fail silently.
      toast({ message: failed, tone: 'danger' });
    }
  }
  return (
    <IconButton label={label} icon={Copy} size="sm" className="-my-1.5 -mr-1.5" onClick={() => void copy()} />
  );
}

/** Copies a full id that the page shows shortened to 8 characters (§10.5): an order's, or a drop's in admin. */
export function CopyId({ id, noun }: { id: string; noun: 'order' | 'drop' }) {
  return (
    <CopyText
      text={id}
      label={`Copy ${noun} id`}
      done={`${noun === 'order' ? 'Order' : 'Drop'} id copied.`}
      failed={`Couldn't copy the ${noun} id.`}
    />
  );
}
