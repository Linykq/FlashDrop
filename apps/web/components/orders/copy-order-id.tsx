'use client';

import { Copy } from 'lucide-react';
import { IconButton } from '../ui/icon-button';
import { toast } from '../ui/toast';

/** Copies the full order id, which the details list shortens to 8 characters (§10.5). */
export function CopyOrderId({ orderId }: { orderId: string }) {
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(orderId);
      toast({ message: 'Order id copied.' });
    } catch {
      // Clipboard access refused (an insecure origin, a denied permission): say so rather than fail silently.
      toast({ message: "Couldn't copy the order id.", tone: 'danger' });
    }
  }
  return (
    // Pulled out by most of its padding, so the glyph lines up with the values above and below it.
    <IconButton
      label="Copy order id"
      icon={Copy}
      size="sm"
      className="-my-1.5 -mr-1.5"
      onClick={() => void copy()}
    />
  );
}
