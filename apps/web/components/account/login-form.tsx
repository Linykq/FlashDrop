'use client';

import type { SessionUser } from '@flashdrop/contracts';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState, useTransition } from 'react';
import { signIn } from '../../lib/auth-client';
import { cx } from '../../lib/cx';
import { initials } from '../../lib/text';
import { Avatar } from '../ui/avatar';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';

type LoginFormProps = {
  users: readonly SessionUser[];
  /** The signed-in account, checked to start with; choosing another one switches to it. */
  currentUserId: string | null;
  /** A same-origin path, already checked on the server. */
  returnTo: string;
  className?: string;
};

/**
 * The dev sign-in (design-system §10.6): the seeded accounts as one grouped list of radio rows, a native
 * radio group, so the arrow keys move the choice, and one button. Signed out it says "Continue". Signed in,
 * the current account is chosen and there is nothing to do yet, so the button only fades in, naming the
 * account it switches to, once another one is chosen; its slot is kept, so nothing below it moves. api sets
 * the session cookie; the router then refreshes, so every Server Component, the navigation bar included,
 * reads the new session on the way to `returnTo`.
 */
export function LoginForm({ users, currentUserId, returnTo, className }: LoginFormProps) {
  const router = useRouter();
  const [selected, setSelected] = useState(currentUserId ?? users[0]?.id ?? '');
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const switching = currentUserId !== null;
  const unchanged = selected === currentUserId;
  const selectedName = users.find((user) => user.id === selected)?.displayName;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending || !selected || unchanged) return;
    setFailed(false);
    startTransition(async () => {
      if (!(await signIn(selected))) {
        setFailed(true);
        return;
      }
      router.replace(returnTo);
      router.refresh();
    });
  }

  const idle = switching && unchanged;
  const rest = !switching ? 'Continue' : selectedName ? `Switch to ${selectedName}` : 'Switch account';
  const busy = switching ? 'Switching…' : 'Signing in…';

  return (
    <form onSubmit={submit} className={className}>
      {failed && (
        <Banner tone="danger" alert className="mb-4">
          Couldn't sign you in. Try again in a moment.
        </Banner>
      )}
      {/* min-w-0: a fieldset is min-content wide by default, which would push the list past a 320 px screen. */}
      <fieldset className="min-w-0">
        {/* Signed out the heading already says it; signed in, the list is for switching (§9.5). */}
        <legend className={switching ? 'mb-3 text-headline' : 'sr-only'}>
          {switching ? 'Switch account' : 'Account'}
        </legend>
        <div className="divide-y divide-separator rounded-lg border border-separator bg-surface">
          {users.map((user) => (
            <AccountOption
              key={user.id}
              user={user}
              checked={user.id === selected}
              onChange={() => setSelected(user.id)}
            />
          ))}
        </div>
      </fieldset>
      {/* The wrapper fades, so the button's own colour transition is left alone; `invisible` also takes the
          button out of the tab order and the accessibility tree while it is idle. */}
      <div
        className={cx(
          'mt-6 transition-[opacity,visibility] duration-200',
          idle ? 'invisible opacity-0 ease-in' : 'visible opacity-100 ease-out',
        )}
      >
        <Button type="submit" size="lg" shape="rounded" fullWidth disabled={idle} loading={pending}>
          {pending ? busy : rest}
        </Button>
      </div>
    </form>
  );
}

/**
 * One row of the grouped list (§9.5): the whole row is the label, 64 px tall, separated by hairlines rather
 * than boxed. The filled radio alone marks the choice, as in an iOS grouped list: an accent tint behind the
 * row would take the email's `label-secondary` below 4.5:1. The radio's own 1 px border is the 3:1 control
 * boundary; in forced colours, where fills are dropped, the checked radio's border thickens into a ring.
 * The row draws the focus ring for its visually native radio.
 */
function AccountOption({
  user,
  checked,
  onChange,
}: {
  user: SessionUser;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={cx(
        'flex min-h-16 cursor-pointer items-center gap-3 px-4 py-3 first:rounded-t-lg last:rounded-b-lg',
        'transition-colors duration-200 ease-standard',
        'has-focus-visible:outline-3 has-focus-visible:outline-focus has-focus-visible:outline-offset-2',
        !checked && 'hover:bg-fill-quaternary',
      )}
    >
      <span className="grid size-5.5 shrink-0 place-items-center">
        <input
          type="radio"
          name="userId"
          value={user.id}
          checked={checked}
          onChange={onChange}
          className="peer col-start-1 row-start-1 size-5.5 appearance-none rounded-full border border-control bg-surface checked:border-accent checked:bg-accent focus-visible:outline-none forced-colors:checked:border-7"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none col-start-1 row-start-1 size-2 rounded-full bg-label-on-color opacity-0 peer-checked:opacity-100"
        />
      </span>
      <Avatar initials={initials(user.displayName)} size="lg" />
      {/* The badge wraps under the name and email when the row is too narrow for all three (320 px). */}
      <span className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="min-w-0">
          <span className="block text-body font-medium">{user.displayName}</span>
          <span className="block text-footnote text-label-secondary wrap-anywhere">{user.email}</span>
        </span>
        {user.role === 'admin' && (
          <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-fill-tertiary px-2.5 text-caption font-medium">
            Admin
          </span>
        )}
      </span>
    </label>
  );
}
