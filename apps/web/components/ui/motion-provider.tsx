'use client';

import { LazyMotion, MotionConfig } from 'framer-motion';
import type { ReactNode } from 'react';

// Animation features load after the island mounts, so they never weigh on the first paint (§8.5).
const loadMotionFeatures = () => import('./motion-features').then((mod) => mod.default);

/**
 * The motion setup of design-system §8.5, around each island that renders `m.*` (the toast stack, the sheet)
 * rather than around the whole app: even LazyMotion and MotionConfig pull about 16 KB gzipped of framer-motion
 * into whatever bundle imports them, and at the root that was every page's first load, over the 160 KB
 * budget (§14). Islands that animate load it with themselves.
 *
 * - `LazyMotion strict` throws on `motion.*`, which would bundle every feature; components use `m.*`.
 *   Animation code comes from `framer-motion`, the package `motion/react` re-exports: `motion/react`
 *   re-exports it through a namespace import that Turbopack cannot tree-shake.
 * - `reducedMotion="user"` drops transform and layout animation when the OS asks for less motion.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
