import { formatCount } from './format';
import type { StockState } from './stock';
import type { ReserveProblem } from './use-reserve';

/**
 * How the note under the Buy button reads (§9.13, copy from §12.2). The tone says whose move it is: `neutral`
 * for an outcome nobody did wrong (sold out, the limit, the window), `warning` for "slow down", `danger` when
 * the request itself failed and trying again is the next step.
 */
export type ReserveNoteTone = 'neutral' | 'warning' | 'danger';

export type ReserveNote = {
  tone: ReserveNoteTone;
  /** Which glyph of the canonical set (§7) goes with it. */
  glyph: 'not-reserved' | 'info' | 'expired' | 'warning' | 'error' | 'offline';
  text: string;
};

type NoteContext = {
  perUserLimit: number;
  /** The drop's live stock, refreshed after the refusal: a SOLD_OUT is worded from it. */
  stock: StockState;
};

export function reserveNote(problem: ReserveProblem, { perUserLimit, stock }: NoteContext): ReserveNote {
  switch (problem.kind) {
    case 'refused':
      switch (problem.code) {
        case 'SOLD_OUT':
          return soldOutNote(problem.qty, stock);
        case 'LIMIT_REACHED':
          return {
            tone: 'neutral',
            glyph: 'info',
            text: `You've reached the limit of ${formatCount(perUserLimit)} for this drop.`,
          };
        case 'DROP_NOT_LIVE':
          return { tone: 'neutral', glyph: 'info', text: "This drop isn't live right now." };
        case 'RESERVATION_EXPIRED':
          return {
            tone: 'neutral',
            glyph: 'expired',
            text: 'That reservation expired. Try again if any are left.',
          };
        case 'IDEMPOTENCY_KEY_REUSED':
          return {
            tone: 'danger',
            glyph: 'error',
            text: "Something didn't match. Refresh the page and try again.",
          };
      }
      break;
    case 'unavailable':
      if (problem.cause === 'rate-limited') {
        return { tone: 'warning', glyph: 'warning', text: 'Too many tries. Wait a moment, then try again.' };
      }
      if (problem.cause === 'offline') {
        return {
          tone: 'danger',
          glyph: 'offline',
          text: "You're offline. Check your connection and try again.",
        };
      }
      break;
    case 'failed':
      break;
  }
  return { tone: 'danger', glyph: 'error', text: "We couldn't reserve right now. Try again." };
}

/**
 * Redis refuses SOLD_OUT whenever fewer than `qty` are available (SD §4.2), which isn't always "sold out": a
 * press for 2 with 1 left, or the last unit going to a cart that may still free it. So the note says what the
 * stock says now. Units that came back between the refusal and the refresh leave nothing to explain but the
 * change itself.
 */
function soldOutNote(qty: number, { avail, held }: StockState): ReserveNote {
  if (avail >= qty) return { tone: 'neutral', glyph: 'info', text: 'Stock just changed. Try again.' };
  if (avail > 0) {
    const left = formatCount(avail);
    return {
      tone: 'neutral',
      glyph: 'info',
      text: `Only ${left} left now. We set your quantity to ${left}.`,
    };
  }
  if (held > 0) {
    return { tone: 'neutral', glyph: 'not-reserved', text: 'All reserved right now. Some may free up.' };
  }
  return { tone: 'neutral', glyph: 'not-reserved', text: 'Sold out. Every unit has been claimed.' };
}
