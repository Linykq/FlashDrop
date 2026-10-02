import type { Transition } from 'framer-motion';

/**
 * The only springs in the product (design-system §6.3). `visualDuration` is the time to visually reach the
 * target, so springs line up with the 200 and 300 ms CSS durations.
 */
export const spring = {
  /**
   * Tab indicator, live stock number swap. The segmented thumb (in every page's footer) and the stepper
   * value (on the product page) use CSS on the same 250 ms instead, so no first load carries framer-motion
   * (§14).
   */
  snappy: { type: 'spring', visualDuration: 0.25, bounce: 0.1 },
  /** Sheets, toast stack reflow, drop card docking. */
  smooth: { type: 'spring', visualDuration: 0.4, bounce: 0 },
  /** Only the PAID check mark and the "Reserved" confirmation. */
  celebrate: { type: 'spring', visualDuration: 0.5, bounce: 0.3 },
} as const satisfies Record<string, Transition>;

/** Every exit: 200 ms, `ease-in` (the CSS `--ease-in` curve). */
export const exitTransition = { duration: 0.2, ease: [0.7, 0, 0.84, 0] } as const satisfies Transition;
