'use client';

import type Hls from 'hls.js';
import { type RefObject, useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { serverClockNow } from '../../lib/clock';
import { isBehindLive, livePosition } from '../../lib/stream';

/*
 * The live player's behaviours, one hook each, so a change to one (the idle timer, fullscreen, the source)
 * is read without the others' effects (design-system §10.3). Each reads the `<video>` or the player's
 * container through a ref the player owns.
 */

const CAPTIONS_KEY = 'fd-captions';
/** The controls fade after this long without the pointer moving, while playing (§10.3). */
const IDLE_MS = 3_000;
/** How often the player checks whether it fell behind the live point. */
const BEHIND_CHECK_MS = 1_000;

function storedCaptions(): boolean {
  // Storage can throw (private mode, blocked site data): captions then start off, the default.
  try {
    return localStorage.getItem(CAPTIONS_KEY) === 'on';
  } catch {
    return false;
  }
}

function storeCaptions(on: boolean): void {
  try {
    localStorage.setItem(CAPTIONS_KEY, on ? 'on' : 'off');
  } catch {
    // The choice holds for this page only.
  }
}

/**
 * Whether captions are on, remembered per device (§10.3), and the toggle. The stored choice is read after
 * hydration: the server can't know it, and the markup must match. The room owns it, so both the player's own
 * button and the room's "Turn on captions" change the same state.
 */
export function useCaptionsPreference(): readonly [on: boolean, toggle: () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(storedCaptions());
  }, []);
  const toggle = useCallback(() => {
    setOn((current) => {
      storeCaptions(!current);
      return !current;
    });
  }, []);
  return [on, toggle] as const;
}

type HlsAttachment = {
  video: RefObject<HTMLVideoElement | null>;
  src: string;
  /** Attached while the drop is on air, detached otherwise. */
  enabled: boolean;
  /** Bumped by Retry, which attaches the source again. */
  attempt: number;
  /** The stream can't play: after hls.js's own retries, or the browser's one automatic retry (§10.3). */
  onFatal: () => void;
  /** The stream knows its length: start (or, under reduced motion, only seek) at the live point. */
  onLoaded: () => void;
  /** Where the loop is live, for a stream of `duration` seconds. */
  livePoint: (duration: number) => number;
};

/**
 * The source: the browser's own HLS where it has one (Safari), hls.js otherwise, imported only once the player
 * mounts so it stays out of every first load (design-system §8.7, §14).
 */
export function useHlsAttachment({
  video,
  src,
  enabled,
  attempt,
  onFatal,
  onLoaded,
  livePoint,
}: HlsAttachment) {
  const fatal = useEffectEvent(onFatal);
  const loaded = useEffectEvent(onLoaded);
  const point = useEffectEvent(livePoint);

  // `attempt` is a dependency only to attach again on Retry.
  useEffect(() => {
    const element = video.current;
    if (!element || !enabled) return;
    const onMetadata = () => loaded();
    element.addEventListener('loadedmetadata', onMetadata, { once: true });
    const detach = () => {
      element.removeEventListener('loadedmetadata', onMetadata);
      element.removeAttribute('src');
      element.load();
    };

    if (element.canPlayType('application/vnd.apple.mpegurl') !== '') {
      let retried = false;
      const onError = () => {
        if (retried) {
          fatal();
          return;
        }
        retried = true;
        element.src = src;
        element.load();
      };
      element.addEventListener('error', onError);
      element.src = src;
      return () => {
        element.removeEventListener('error', onError);
        detach();
      };
    }

    let hls: Hls | undefined;
    let cancelled = false;
    import('hls.js').then(
      ({ default: HlsPlayer }) => {
        if (cancelled) return;
        if (!HlsPlayer.isSupported()) {
          fatal();
          return;
        }
        // hls.js retries network and media errors itself; a fatal one is what is left after its retries.
        const player = new HlsPlayer({ capLevelToPlayerSize: true, autoStartLoad: false });
        hls = player;
        player.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (data.fatal) fatal();
        });
        // Loading starts once the playlist says how long the loop is, right at the live point: hls.js would
        // otherwise start a VOD at 0 and overrule an earlier seek.
        player.once(HlsPlayer.Events.LEVEL_LOADED, (_event, data) => {
          player.startLoad(point(data.details.totalduration));
        });
        player.loadSource(src);
        player.attachMedia(element);
      },
      // The chunk could not load (offline, or a deploy replaced it): Retry loads it again.
      () => {
        if (!cancelled) fatal();
      },
    );
    return () => {
      cancelled = true;
      hls?.destroy();
      detach();
    };
  }, [video, src, enabled, attempt]);
}

/** Playing and muted, from the element itself, whatever changed them (controls, keys, the OS, autoplay). */
export function usePlayback(video: RefObject<HTMLVideoElement | null>): { playing: boolean; muted: boolean } {
  const [state, setState] = useState({ playing: false, muted: true });
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const sync = () => setState({ playing: !element.paused, muted: element.muted });
    const events = ['play', 'pause', 'volumechange', 'emptied'] as const;
    for (const event of events) element.addEventListener(event, sync);
    sync();
    return () => {
      for (const event of events) element.removeEventListener(event, sync);
    };
  }, [video]);
  return state;
}

/**
 * Whether the pointer moved recently: shown when the player appears, so the controls are discovered, then idle
 * after 3 s like any other moment. `poke` on every pointer move or press.
 */
export function useIdleControls(): { active: boolean; poke: () => void } {
  const [active, setActive] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    timer.current = setTimeout(() => setActive(false), IDLE_MS);
    return () => clearTimeout(timer.current);
  }, []);
  const poke = useCallback(() => {
    setActive(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setActive(false), IDLE_MS);
  }, []);
  return { active, poke };
}

type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen(): void };

/** iPhone Safari has no element fullscreen, only the video's own (§10.3). */
function hasVideoFullscreen(video: HTMLVideoElement): video is WebkitVideo {
  return typeof Reflect.get(video, 'webkitEnterFullscreen') === 'function';
}

/**
 * Fullscreen on the player's container, so the badges, the capsules and the docked drop card stay on screen;
 * the video's own fullscreen where element fullscreen doesn't exist (iPhone), without them.
 */
export function useFullscreen(
  container: RefObject<HTMLElement | null>,
  video: RefObject<HTMLVideoElement | null>,
): { fullscreen: boolean; toggle: () => void } {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [container]);
  const toggle = useCallback(() => {
    const element = container.current;
    const media = video.current;
    if (!element || !media) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else if (typeof element.requestFullscreen === 'function' && document.fullscreenEnabled) {
      void element.requestFullscreen().catch(() => undefined);
    } else if (hasVideoFullscreen(media)) {
      media.webkitEnterFullscreen();
    }
  }, [container, video]);
  return { fullscreen, toggle };
}

/** Behind the live point: after a pause, or a stall. Checked once a second, while the stream is on air. */
export function useBehindLive(
  video: RefObject<HTMLVideoElement | null>,
  live: boolean,
  fallbackOffset: number,
): boolean {
  const [behind, setBehind] = useState(false);
  useEffect(() => {
    if (!live) {
      setBehind(false);
      return;
    }
    const timer = setInterval(() => {
      const element = video.current;
      if (!element || !Number.isFinite(element.duration) || element.readyState === 0) return;
      const point = livePosition(serverClockNow(fallbackOffset), element.duration);
      setBehind(isBehindLive(element.currentTime, point, element.duration));
    }, BEHIND_CHECK_MS);
    return () => clearInterval(timer);
  }, [video, live, fallbackOffset]);
  return behind;
}

/** The cue that just started: its id is the product on screen (SD §8.1), its text what is being said. */
export type ActiveCue = { id: string; text: string };

/**
 * Calls `onCue` each time a new cue starts on the captions track. The track is `hidden` while captions are off
 * (never `disabled`), so cues still load and fire with nothing on screen. The gaps between cues are ignored:
 * the product stays on screen through them.
 */
export function useCueChange(
  video: RefObject<HTMLVideoElement | null>,
  onCue: (cue: ActiveCue) => void,
): void {
  const report = useEffectEvent(onCue);
  useEffect(() => {
    const track = video.current?.textTracks[0];
    if (!track) return;
    let last: string | null = null;
    const onChange = () => {
      const cue = track.activeCues?.[0];
      if (!(cue instanceof VTTCue) || cue.id === '' || cue.id === last) return;
      last = cue.id;
      report({ id: cue.id, text: cue.text });
    };
    track.addEventListener('cuechange', onChange);
    return () => track.removeEventListener('cuechange', onChange);
  }, [video]);
}
