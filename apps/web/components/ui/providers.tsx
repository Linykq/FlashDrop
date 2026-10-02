'use client';

import { LucideProvider } from 'lucide-react';
import type { ReactNode } from 'react';
import { Announcer } from './announcer';
import { ToastRegion } from './toast';

/**
 * Client-side context for the whole app. Children stay Server Components. Motion is not set up here but
 * around each island that animates (`MotionProvider`), to keep it out of every page's first load (§14).
 *
 * Icons default to md: 20 px with a 1.75 px stroke that stays 1.75 px at every size, which matches SF
 * Symbols' regular weight next to 17 px text (§7). `nonScalingStroke` is lucide 1.x's replacement for the
 * deprecated `absoluteStrokeWidth`.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <LucideProvider size={20} strokeWidth={1.75} nonScalingStroke>
      {children}
      <Announcer />
      <ToastRegion />
    </LucideProvider>
  );
}
