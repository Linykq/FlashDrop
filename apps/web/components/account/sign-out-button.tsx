'use client';

import { LogOut } from 'lucide-react';
import { useSignOut } from '../../lib/use-sign-out';
import { Button } from '../ui/button';

/**
 * "Sign out" on the account page, at the end of the title's row. A failure is said under the button and
 * politely announced. No reserved label width: anchored at the row's end, the button grows leftwards into
 * free space for "Signing out…", and a reserved slot would leave a gap between its label and the edge.
 */
export function SignOutButton() {
  const { pending, failed, run } = useSignOut();
  return (
    <div className="flex flex-col items-end">
      <Button variant="plain" icon={LogOut} loading={pending} onClick={run}>
        {pending ? 'Signing out…' : 'Sign out'}
      </Button>
      <p role="status" className="text-footnote text-danger">
        {failed ? "Couldn't sign out. Try again." : ''}
      </p>
    </div>
  );
}
