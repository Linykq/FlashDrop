'use client';

import { Copy } from 'lucide-react';
import { IconButton } from './icon-button';
import { toast } from './toast';

/**
 * Copies a full id that the page shows shortened to 8 characters (§10.5): an order's, or a drop's in admin.
 * The icon button is pulled out by most of its padding, so the glyph lines up with the values above and below.
 */
export function CopyId({ id, noun }: { id: string; noun: 'order' | 'drop' }) {
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(id);
      toast({ message: `${noun === 'order' ? 'Order' : 'Drop'} id copied.` });
    } catch {
      // Clipboard access refused (an insecure origin, a denied permission): say so rather than fail silently.
      toast({ message: `Couldn't copy the ${noun} id.`, tone: 'danger' });
    }
  }
  return (
    <IconButton
      label={`Copy ${noun} id`}
      icon={Copy}
      size="sm"
      className="-my-1.5 -mr-1.5"
      onClick={() => void copy()}
    />
  );
}
