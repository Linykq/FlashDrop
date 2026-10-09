import { Link2Off } from 'lucide-react';
import { RouteState } from '../../components/layout/route-state';
import { ButtonLink } from '../../components/ui/button';

/**
 * A drop, job or dashboard that doesn't exist (§10.0), inside the admin's own bar and sidebar: the root
 * not-found page brings the store's chrome, which would nest inside this layout. The way back is the drops list.
 */
export default function AdminNotFound() {
  return (
    <>
      <title>Page not found · FlashDrop</title>
      <RouteState
        icon={Link2Off}
        title="Page not found"
        description="This link may be old or mistyped."
        action={
          <ButtonLink href="/admin/drops" variant="tinted">
            Go to drops
          </ButtonLink>
        }
      />
    </>
  );
}
