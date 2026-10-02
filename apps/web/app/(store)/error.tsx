'use client';

import { CircleX } from 'lucide-react';
import { RouteState } from '../../components/layout/route-state';
import { Button } from '../../components/ui/button';

/**
 * The storefront's error state, inside its navigation bar and footer (§10.0). `retry` refetches server data
 * and re-renders the segment; the server already logged the error with its digest.
 */
export default function StoreError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
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
