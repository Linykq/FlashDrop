/*
 * The live sample's WebVTT captions (SD §8.1): each cue's id is the slug of the product on screen while it
 * runs, so the captions file is also the show's running order. Pure parsing, so the room's server render and
 * the tests read it the same way; the player reads the same cues from its text track.
 */

export type Cue = {
  /** The product on screen: a cue id is a product slug (SD §8.1). */
  id: string;
  /** Seconds from the start of the loop. */
  start: number;
  end: number;
  /** The spoken line, one caption line per array entry. */
  lines: string[];
};

const TIMING = /^(\S+)\s+-->\s+(\S+)/;

/** `hh:mm:ss.ttt` or `mm:ss.ttt` in seconds; `NaN` for anything else. */
function seconds(timestamp: string): number {
  const parts = timestamp.split(':');
  if (parts.length < 2 || parts.length > 3) return Number.NaN;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

/**
 * The cues of a WebVTT file that have an id, in file order. Header, NOTE, STYLE and REGION blocks have no
 * timing line and are skipped; a cue without an id names no product, so it is skipped too.
 */
export function parseCues(vtt: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of vtt.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const [id, timing, ...lines] = block.trim().split('\n');
    const match = timing === undefined ? null : TIMING.exec(timing);
    if (id === undefined || match === null || id.includes('-->')) continue;
    const start = seconds(match[1] ?? '');
    const end = seconds(match[2] ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    cues.push({ id: id.trim(), start, end, lines: lines.map((line) => line.trim()).filter(Boolean) });
  }
  return cues;
}

/** The show's running order: each product once, where it first appears. */
export function segmentSlugs(cues: readonly Cue[]): string[] {
  return [...new Set(cues.map((cue) => cue.id))];
}

/**
 * The last `count` cues spoken by `position` seconds into the loop, oldest first, wrapping around the loop's
 * end: what a viewer who joins now has just missed. Empty when the file has no cues.
 */
export function recentCues(cues: readonly Cue[], position: number, count: number): Cue[] {
  if (cues.length === 0) return [];
  let current = cues.findLastIndex((cue) => cue.start <= position);
  if (current === -1) current = cues.length - 1;
  const recent: Cue[] = [];
  for (let back = Math.min(count, cues.length) - 1; back >= 0; back -= 1) {
    const cue = cues[(current - back + cues.length) % cues.length];
    if (cue) recent.push(cue);
  }
  return recent;
}
