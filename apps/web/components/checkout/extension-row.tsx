'use client';

import { CircleCheck } from 'lucide-react';
import { useRef } from 'react';
import { cx } from '../../lib/cx';
import { LocalTime } from '../commerce/local-time';
import { Button } from '../ui/button';
import type { ExtendOrigin, Extension } from './use-hold-extension';

type ExtensionRowProps = {
  extension: Extension;
  onExtend: (origin: ExtendOrigin) => void;
  className?: string;
};

/**
 * "Need more time?" and "Add 1 minute", then what came of it (design-system §10.4, §12.2). A result replaces
 * the button; it takes focus when the button had it (`use-hold-extension.ts`), so it is a focus target itself.
 */
export function ExtensionRow({ extension, onExtend, className }: ExtensionRowProps) {
  const result = useRef<HTMLParagraphElement>(null);
  const row = cx('flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2', className);

  if (extension.kind === 'added' || extension.kind === 'added-elsewhere') {
    return (
      <div className={row}>
        <p
          ref={result}
          tabIndex={-1}
          className="flex items-start gap-1.5 text-callout text-success outline-none"
        >
          <CircleCheck size={16} className="mt-0.5 shrink-0" />
          {extension.kind === 'added' ? (
            '1 minute added'
          ) : (
            <span>
              1 minute was added. Your hold ends at <LocalTime iso={extension.expiresAt} format="time" />.
            </span>
          )}
        </p>
      </div>
    );
  }
  if (extension.kind === 'refused') {
    return (
      <div className={row}>
        <p ref={result} tabIndex={-1} className="text-callout text-label-secondary outline-none">
          Couldn't add time. Your hold ends at <LocalTime iso={extension.expiresAt} format="time" />.
        </p>
      </div>
    );
  }
  return (
    <div className={row}>
      <p className="text-callout">
        {extension.kind === 'failed' ? "Couldn't add time. Try again." : 'Need more time?'}
      </p>
      <Button
        variant="tinted"
        size="sm"
        loading={extension.kind === 'adding'}
        reserve={['Add 1 minute', 'Adding…']}
        onClick={(event) => onExtend({ hadFocus: document.activeElement === event.currentTarget, result })}
      >
        {extension.kind === 'adding' ? 'Adding…' : 'Add 1 minute'}
      </Button>
    </div>
  );
}
