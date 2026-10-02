import { Link2Off } from 'lucide-react';
import { ButtonLink } from '../ui/button';
import { RouteState } from './route-state';

/** "Page not found" (§10.0): the empty-state layout with the page's `h1` and the way back to the drops. */
export function NotFoundState() {
  return (
    <RouteState
      icon={Link2Off}
      title="Page not found"
      description="This link may be old or mistyped."
      action={
        <ButtonLink href="/" variant="tinted">
          Go to drops
        </ButtonLink>
      }
    />
  );
}
