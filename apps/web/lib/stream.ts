import type { PublicDropStatus } from '@flashdrop/domain';

/*
 * The live room's stream (SD §8.1, design-system §10.3). The sample stream is a 48 s fMP4 VOD that loops, so
 * the room plays it as if it were live: everyone in the room sees the same moment, the one the server's clock
 * points at, and a viewer who paused is "behind the live edge" until they jump back.
 */

/** The stream's files: the playlist, and beside it its poster and English captions (`public/hls/`). */
export type StreamAssets = { src: string; poster: string; captions: string };

/**
 * A room stores only its playlist's URL (`rooms.hls_url`); the poster and the captions live next to it, by
 * the convention of `public/hls/` (SD §8.1), so they are found relative to it.
 */
export function streamAssets(hlsUrl: string): StreamAssets {
  const base = hlsUrl.slice(0, hlsUrl.lastIndexOf('/') + 1);
  return { src: hlsUrl, poster: `${base}poster.jpg`, captions: `${base}captions.en.vtt` };
}

/** `live` plays; before the drop opens and after it ends the poster says so instead (§10.3 "No stream"). */
export type StreamState = 'live' | 'upcoming' | 'ended';

/** The stream follows the room's pinned drop: on air while it is open, paused included; none pinned is "soon". */
export function streamState(status: PublicDropStatus | null): StreamState {
  switch (status) {
    case 'LIVE':
    case 'PAUSED':
      return 'live';
    case 'ENDED':
      return 'ended';
    case 'SCHEDULED':
    case null:
      return 'upcoming';
  }
}

/** Where the loop is "live" at `serverNow` (epoch ms): the same second for every viewer. */
export function livePosition(serverNow: number, duration: number): number {
  return duration > 0 ? (serverNow / 1000) % duration : 0;
}

/** Seconds of drift tolerated before the player counts as behind: buffering and clock noise. */
const LIVE_TOLERANCE_S = 4;

/**
 * Whether `position` trails the live point on the loop by more than the tolerance. A position slightly ahead
 * (clock noise) wraps around to almost a whole loop behind, which is also within the tolerance.
 */
export function isBehindLive(position: number, live: number, duration: number): boolean {
  if (!(duration > LIVE_TOLERANCE_S * 2)) return false;
  const behind = (((live - position) % duration) + duration) % duration;
  return behind > LIVE_TOLERANCE_S && behind < duration - LIVE_TOLERANCE_S;
}
