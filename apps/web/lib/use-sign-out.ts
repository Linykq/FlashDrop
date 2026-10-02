import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { signOut } from './auth-client';

/**
 * Ends the session, then refreshes the route, so every Server Component (the navigation bar included)
 * re-renders signed out in place. `failed` stays set until the next attempt.
 */
export function useSignOut(): { pending: boolean; failed: boolean; run: () => void } {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  function run(): void {
    if (pending) return;
    setFailed(false);
    startTransition(async () => {
      if (await signOut()) router.refresh();
      else setFailed(true);
    });
  }

  return { pending, failed, run };
}
