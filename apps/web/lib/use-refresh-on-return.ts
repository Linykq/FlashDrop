import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Next reveals a page it kept in a hidden <Activity> (Back, "Leave checkout", "Try again") as it was left,
 * without asking the server again, and its effects run again. A page whose content is live server data (a
 * hold, an order's status) calls this to ask for the page again when revealed; the router keeps the old one on
 * screen until the new one arrives, and a page that no longer applies redirects from the server.
 */
export function useRefreshOnReturn(): void {
  const router = useRouter();
  const away = useRef(false);
  useEffect(() => {
    if (away.current) router.refresh();
    away.current = false;
    // Marked a task later, so React's development-only remount, cleanup and setup in one go, isn't a return.
    return () => {
      setTimeout(() => {
        away.current = true;
      }, 0);
    };
  }, [router]);
}
