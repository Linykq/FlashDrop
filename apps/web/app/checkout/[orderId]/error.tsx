'use client';

import { CircleX } from 'lucide-react';
import { RouteState } from '../../../components/layout/route-state';
import { Button } from '../../../components/ui/button';

/**
 * Checkout's error state, inside checkout's own chrome (§10.0). `retry` refetches the order and re-renders
 * the page; the server already logged the error with its digest.
 */
export default function CheckoutError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <>
      <title>Error · FlashDrop</title>
      <RouteState
        icon={CircleX}
        title="Something went wrong"
        description="Try again in a moment."
        action={
          <Button variant="tinted" onClick={retry}>
            Try again
          </Button>
        }
      />
    </>
  );
}
