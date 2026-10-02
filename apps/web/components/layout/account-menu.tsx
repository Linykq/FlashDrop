'use client';

import { ChevronRight, LogOut } from 'lucide-react';
import Link from 'next/link';
import { useId, useRef } from 'react';
import { cx } from '../../lib/cx';
import { useSignOut } from '../../lib/use-sign-out';
import { Avatar } from '../ui/avatar';
import { Spinner } from '../ui/spinner';
import type { NavAccount } from './nav-bar';

const rowClass =
  'flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-callout text-label transition-colors duration-100 ease-standard hover:bg-fill-quaternary hover:duration-200 active:bg-fill-tertiary active:duration-0';

/**
 * The avatar and its menu: who is signed in, the account page and signing out. A native `popover`, which
 * brings light dismiss, Esc and the invoker's expanded state without a library (design-system §8.6). It
 * floats on `material-thick`, so everything in it is `label` (§2.5).
 */
export function AccountMenu({ account }: { account: NavAccount }) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  // Signed out, the bar re-renders without this menu, which closes it.
  const { pending, failed, run: signOut } = useSignOut();
  const close = () => menu.current?.hidePopover();

  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-label={`Account, ${account.name}`}
        className="-mx-2 inline-flex size-11 items-center justify-center rounded-full"
      >
        <Avatar initials={account.initials} />
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        className="popover-nav-end material-thick w-64 rounded-lg p-1.5 text-label elevation-2"
      >
        <div className="flex items-center gap-3 px-3 pt-2.5 pb-3">
          <Avatar initials={account.initials} size="lg" />
          <p className="min-w-0 text-headline">{account.name}</p>
        </div>
        <div aria-hidden="true" className="mx-3 mb-1.5 h-px bg-separator" />
        <Link href="/login" onClick={close} className={rowClass}>
          <span className="flex-1">Account</span>
          <ChevronRight size={16} />
        </Link>
        {account.adminHref && (
          <Link href={account.adminHref} onClick={close} className={rowClass}>
            <span className="flex-1">Admin</span>
            <ChevronRight size={16} />
          </Link>
        )}
        <button
          type="button"
          aria-busy={pending || undefined}
          onClick={signOut}
          className={cx(rowClass, pending && 'cursor-default')}
        >
          <span className="flex-1 text-start">{pending ? 'Signing out…' : 'Sign out'}</span>
          {pending ? <Spinner /> : <LogOut size={16} />}
        </button>
        {failed && (
          <p role="alert" className="px-3 pt-1 pb-2 text-footnote">
            Couldn't sign out. Try again.
          </p>
        )}
      </div>
    </>
  );
}
