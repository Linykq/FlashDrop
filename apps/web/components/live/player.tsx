'use client';

import type Hls from 'hls.js';
import {
  Captions,
  CaptionsOff,
  Maximize,
  Minimize,
  Pause,
  Play,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from 'react';
import { preload } from 'react-dom';
import { serverClockNow } from '../../lib/clock';
import { cx } from '../../lib/cx';
import { isBehindLive, livePosition, type StreamAssets, type StreamState } from '../../lib/stream';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';

export type PlayerProps = {
  stream: StreamAssets;
  state: StreamState;
  /** The server's clock when the page rendered (epoch ms): where the loop is live until the socket says. */
  serverNow: number;
  /** The LIVE badge and the viewer count, over the top-left corner. */
  badges: ReactNode;
  /** The drop card, docked over the video while the player is fullscreen (design-system §9.12). */
  docked: ReactNode;
  className?: string;
};

/** The controls fade after this long without the pointer moving, while playing (§10.3). */
const IDLE_MS = 3_000;
/** How often the player checks whether it fell behind the live point. */
const BEHIND_CHECK_MS = 1_000;
const CAPTIONS_KEY = 'fd-captions';
/** Captions clear the capsules while they show: 16 px inset + 52 px capsule + 16 px gap (§10.3). */
const CAPTIONS_ABOVE_CONTROLS_PX = 84;
/** With the capsules hidden, captions keep their 16 px inset from the bottom edge. */
const CAPTIONS_INSET_PX = 16;

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

type Shortcut = 'play' | 'mute' | 'captions' | 'fullscreen';

/** The player's single-key shortcuts (§10.3), or `null`. */
function shortcut(key: string): Shortcut | null {
  switch (key.toLowerCase()) {
    case ' ':
    case 'k':
      return 'play';
    case 'm':
      return 'mute';
    case 'c':
      return 'captions';
    case 'f':
      return 'fullscreen';
    default:
      return null;
  }
}

/**
 * Chrome's cue line as a share of the video's height: its captions are 5% of the height, at a line height of
 * about 1.2. Chrome has no `lineAlign`, so `line` places a cue box's top, and the box's height is estimated.
 */
const CUE_LINE_SHARE = 0.06;

/**
 * Places every cue with its bottom edge `bottomPx` above the video's (the browser otherwise draws cues on the
 * bottom edge, in the capsules' band, §10.3); `null` restores the browser's own placement, for iPhone's
 * native fullscreen, where the page's capsules aren't shown. A cue already on screen keeps the place it was
 * drawn at until it is added again, so the active ones are.
 */
function placeCues(track: TextTrack, height: number, bottomPx: number | null): void {
  const alignsEnd = 'lineAlign' in VTTCue.prototype;
  const bottom = bottomPx === null || height <= 0 ? null : 100 - (bottomPx / height) * 100;
  for (const cue of Array.from(track.cues ?? [])) {
    if (!(cue instanceof VTTCue)) continue;
    if (bottom === null) {
      cue.snapToLines = true;
      cue.line = 'auto';
    } else {
      const lines = cue.text.split('\n').length;
      cue.snapToLines = false;
      cue.lineAlign = 'end';
      cue.line = Math.max(0, alignsEnd ? bottom : bottom - lines * CUE_LINE_SHARE * 100);
    }
  }
  for (const cue of Array.from(track.activeCues ?? [])) {
    track.removeCue(cue);
    track.addCue(cue);
  }
}

type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen(): void };

/** iPhone Safari has no element fullscreen, only the video's own (§10.3). */
function hasVideoFullscreen(video: HTMLVideoElement): video is WebkitVideo {
  return typeof Reflect.get(video, 'webkitEnterFullscreen') === 'function';
}

/**
 * The live room's player (design-system §10.3, SD §8.1): hls.js, or the browser's own HLS where it has one
 * (Safari), playing the room's stream muted and inline, with the WebVTT captions track. The server renders it
 * whole, poster first (the page's largest paint, so it is preloaded); hls.js is imported only once the player
 * mounts, so it stays out of every first load (design-system §8.7, §14). The sample stream is a VOD loop, so
 * the player seeks to the point every viewer shares (`livePosition`) and offers "Live" when the viewer fell
 * behind it.
 *
 * Two capsules of overlay buttons sit at the bottom corners and fade after 3 s without pointer movement
 * while playing, never while focus is inside the player; captions move up to clear them while they show.
 * Single-key shortcuts work only while the player itself has focus (WCAG 2.1.4): Space or K play and pause,
 * M mutes, C toggles captions, F fullscreen. They are exposed as `aria-keyshortcuts` and described, and the
 * player is a tab stop only while there is something to play. Controls that remove themselves when pressed
 * (the unmute pill, Live, Retry) hand focus to the player first, so it never falls to the page.
 * Before and after the drop the poster says the stream starts soon or has ended; a stream that can't play
 * says so with a Retry, and the drop card beside it keeps selling either way.
 */
export function Player({ stream, state, serverNow, badges, docked, className }: PlayerProps) {
  preload(stream.poster, { as: 'image', fetchPriority: 'high' });
  const container = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const captionTrack = useRef<HTMLTrackElement>(null);
  const keysId = useId();
  // Server minus device, as estimated from the render; the socket's hello refines it (`serverClockNow`).
  const [fallbackOffset] = useState(() => serverNow - Date.now());
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [unmutedOnce, setUnmutedOnce] = useState(false);
  const [captions, setCaptions] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // iPhone's own video fullscreen: its controls, not the page's, so captions go back to the browser's place.
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [behind, setBehind] = useState(false);
  // Shown when the player appears, so the controls are discovered, then idle like any other moment.
  const [pointerActive, setPointerActive] = useState(true);
  const [focusWithin, setFocusWithin] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const live = state === 'live' && !failed;

  const goLive = useCallback(() => {
    const element = video.current;
    if (!element || !Number.isFinite(element.duration)) return;
    element.currentTime = livePosition(serverClockNow(fallbackOffset), element.duration);
    void element.play().catch(() => undefined);
  }, [fallbackOffset]);

  // The source: attached while the drop is on air, detached otherwise, and again on Retry. Playback starts
  // at the live point, which every viewer shares.
  const onFatal = useEffectEvent(() => setFailed(true));
  const onLoaded = useEffectEvent(() => goLive());
  const livePoint = useEffectEvent((duration: number) =>
    livePosition(serverClockNow(fallbackOffset), duration),
  );
  useEffect(() => {
    const element = video.current;
    if (!element || state !== 'live') return;
    const detach = () => {
      element.removeAttribute('src');
      element.load();
    };

    if (element.canPlayType('application/vnd.apple.mpegurl') !== '') {
      // The browser's own HLS (Safari). One automatic retry, then the error state (§10.3).
      const loaded = () => onLoaded();
      element.addEventListener('loadedmetadata', loaded, { once: true });
      let retried = false;
      const onError = () => {
        if (retried) {
          onFatal();
          return;
        }
        retried = true;
        element.src = stream.src;
        element.load();
      };
      element.addEventListener('error', onError);
      element.src = stream.src;
      return () => {
        element.removeEventListener('loadedmetadata', loaded);
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
          onFatal();
          return;
        }
        // hls.js retries network and media errors itself; a fatal one is what is left after its retries.
        const player = new HlsPlayer({ capLevelToPlayerSize: true, autoStartLoad: false });
        hls = player;
        player.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (data.fatal) onFatal();
        });
        // Loading starts once the playlist says how long the loop is, right at the live point: hls.js
        // would otherwise start a VOD at 0 and overrule an earlier seek.
        player.once(HlsPlayer.Events.LEVEL_LOADED, (_event, data) => {
          player.startLoad(livePoint(data.details.totalduration));
        });
        player.loadSource(stream.src);
        player.attachMedia(element);
      },
      // The chunk could not load (offline, or a deploy replaced it): Retry loads it again.
      () => {
        if (!cancelled) onFatal();
      },
    );
    return () => {
      cancelled = true;
      hls?.destroy();
      detach();
    };
  }, [stream.src, state, attempt]);

  // The stored choice, read after hydration: the server can't know it, and the markup must match.
  useEffect(() => {
    setCaptions(storedCaptions());
  }, []);

  // Playback state from the element itself, whatever changed it (controls, keys, the OS, autoplay policy).
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const sync = () => {
      setPlaying(!element.paused);
      setMuted(element.muted);
    };
    const events = ['play', 'pause', 'volumechange', 'emptied'] as const;
    for (const event of events) element.addEventListener(event, sync);
    sync();
    return () => {
      for (const event of events) element.removeEventListener(event, sync);
    };
  }, []);

  // Behind the live point: after a pause, or a stall. Checked once a second, while the stream is on air.
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
  }, [live, fallbackOffset]);

  useEffect(() => {
    const track = video.current?.textTracks[0];
    if (track) track.mode = captions ? 'showing' : 'hidden';
  }, [captions]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    idleTimer.current = setTimeout(() => setPointerActive(false), IDLE_MS);
    return () => clearTimeout(idleTimer.current);
  }, []);

  const togglePlay = () => {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => undefined);
    else element.pause();
  };
  const toggleMute = () => {
    const element = video.current;
    if (!element) return;
    element.muted = !element.muted;
    if (!element.muted) setUnmutedOnce(true);
  };
  const toggleCaptions = () => {
    setCaptions((on) => {
      storeCaptions(!on);
      return !on;
    });
  };
  const toggleFullscreen = () => {
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
  };
  const retry = () => {
    setFailed(false);
    setAttempt((count) => count + 1);
  };
  // The unmute pill, Live and Retry leave once pressed: focus moves to the player first, if they had it, or
  // it would fall to <body> (WCAG 2.4.3), and the capsules, still counting focus as inside, would never fade.
  const keepFocus = (event: MouseEvent<HTMLElement>) => {
    if (document.activeElement === event.currentTarget) container.current?.focus({ preventScroll: true });
  };

  const onPointerActivity = () => {
    setPointerActive(true);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setPointerActive(false), IDLE_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Only on the player itself: on a focused control, Space and Enter belong to that control (§10.3).
    if (event.target !== event.currentTarget || !live) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const action = shortcut(event.key);
    if (action === null) return;
    event.preventDefault();
    ({ play: togglePlay, mute: toggleMute, captions: toggleCaptions, fullscreen: toggleFullscreen })[
      action
    ]();
  };

  const controlsShown = live && (!playing || pointerActive || focusWithin);

  // Captions sit above the capsules while they show, at the capsules' inset otherwise. Cues load after the
  // player mounts (the track's `load`), and the share of the height changes with the player's size.
  const placed = useRef('');
  const placeCaptions = useEffectEvent(() => {
    const element = video.current;
    const track = element?.textTracks[0];
    if (!element || !track?.cues) return;
    const bottom = nativeFullscreen ? null : controlsShown ? CAPTIONS_ABOVE_CONTROLS_PX : CAPTIONS_INSET_PX;
    // Only when the place changed: adding a cue again redraws it.
    const key = `${bottom}:${element.clientHeight}:${track.cues.length}`;
    if (placed.current === key) return;
    placed.current = key;
    placeCues(track, element.clientHeight, bottom);
  });
  useEffect(() => {
    placeCaptions();
  }, [controlsShown, nativeFullscreen, captions]);
  useEffect(() => {
    const element = video.current;
    const track = captionTrack.current;
    if (!element || !track) return;
    const place = () => placeCaptions();
    const begin = () => setNativeFullscreen(true);
    const end = () => setNativeFullscreen(false);
    track.addEventListener('load', place);
    element.addEventListener('webkitbeginfullscreen', begin);
    element.addEventListener('webkitendfullscreen', end);
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => {
      track.removeEventListener('load', place);
      element.removeEventListener('webkitbeginfullscreen', begin);
      element.removeEventListener('webkitendfullscreen', end);
      observer.disconnect();
    };
  }, []);
  const message =
    state === 'upcoming'
      ? 'The stream starts soon.'
      : state === 'ended'
        ? 'The stream has ended.'
        : failed
          ? "The stream can't play right now."
          : null;

  return (
    // The player takes focus for its single-key shortcuts, which work only while it has focus (WCAG 2.1.4),
    // the way a native media element does; its controls stay ordinary buttons.
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: see above.
    <section
      ref={container}
      aria-label="Live stream"
      aria-keyshortcuts={live ? 'Space K M C F' : undefined}
      aria-describedby={live ? keysId : undefined}
      // A tab stop only while there is something to play; still focusable from script (-1), so a control
      // that leaves can hand focus to it, and a player that fails while focused keeps focus.
      tabIndex={live ? 0 : -1}
      onKeyDown={onKeyDown}
      onPointerMove={onPointerActivity}
      onPointerDown={onPointerActivity}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next))) setFocusWithin(false);
      }}
      className={cx(
        'relative isolate aspect-video w-full overflow-clip bg-bg',
        '[&:fullscreen]:aspect-auto [&:fullscreen]:rounded-none',
        className,
      )}
    >
      <video
        ref={video}
        poster={stream.poster}
        className="absolute inset-0 size-full object-cover in-[:fullscreen]:object-contain"
        muted
        autoPlay
        playsInline
        loop
        preload="auto"
      >
        <track ref={captionTrack} kind="captions" src={stream.captions} srcLang="en" label="English" />
      </video>
      <p id={keysId} hidden>
        Keyboard: Space or K plays and pauses, M mutes, C turns captions on or off, F toggles full screen.
      </p>

      <div className="absolute top-4 left-4 flex items-center gap-2">{badges}</div>

      {live && muted && !unmutedOnce && (
        <button
          type="button"
          onClick={(event) => {
            keepFocus(event);
            toggleMute();
          }}
          className={cx(
            'material-overlay absolute top-4 right-4 inline-flex h-11 animate-fade-in items-center gap-1.5 rounded-full px-4 text-footnote font-medium transition-colors duration-100 ease-standard hover:bg-label/16 active:bg-label/24',
            // Compact on a phone, where the overlays would otherwise cover over a fifth of a 390 px video
            // (§10.3); the 6 px around it keep the target 44 px tall.
            "max-sm:h-8 max-sm:px-3 max-sm:text-caption max-sm:before:absolute max-sm:before:-inset-1.5 max-sm:before:content-['']",
          )}
        >
          <VolumeX size={16} className="max-sm:size-3.5" />
          Tap to unmute
        </button>
      )}

      {message && (
        <div className="absolute inset-0 grid place-items-center p-4">
          <div className="material-overlay flex max-w-80 animate-fade-in flex-col items-center gap-3 rounded-lg px-5 py-4 text-center">
            <p className="inline-flex items-center gap-2 text-callout">
              <VideoOff size={20} className="shrink-0" />
              {message}
            </p>
            {failed && state === 'live' && (
              <Button
                size="md"
                onClick={(event) => {
                  keepFocus(event);
                  retry();
                }}
              >
                Retry
              </Button>
            )}
          </div>
        </div>
      )}

      {live && (
        <div
          className={cx(
            'absolute inset-x-4 bottom-4 flex items-end justify-between gap-3',
            'transition-opacity duration-200 ease-standard',
            // Hidden capsules let a tap through to the player, which shows them, rather than acting unseen.
            controlsShown ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <div className="material-overlay flex rounded-full p-1">
            <IconButton
              variant="overlay"
              label={playing ? 'Pause' : 'Play'}
              icon={playing ? Pause : Play}
              largeIcon
              onClick={togglePlay}
            />
            <IconButton
              variant="overlay"
              label="Mute"
              pressed={muted}
              icon={muted ? VolumeX : Volume2}
              largeIcon
              onClick={toggleMute}
            />
          </div>
          <div className="material-overlay flex items-center rounded-full p-1">
            {behind && (
              <button
                type="button"
                // The nav's "Live" link and the LIVE badge read the same; the name says what this one does,
                // and still starts from its visible text (WCAG 2.5.3).
                aria-label="Live, jump to the live point"
                onClick={(event) => {
                  keepFocus(event);
                  goLive();
                }}
                className="inline-flex h-11 items-center rounded-full px-4 text-footnote font-medium transition-colors duration-100 ease-standard hover:bg-label/16 active:bg-label/24"
              >
                Live
              </button>
            )}
            {/* The glyph says the state as mute's does, and the pressed wash backs it up: between cues
                nothing else on screen shows whether captions are on. */}
            <IconButton
              variant="overlay"
              label="Captions"
              pressed={captions}
              icon={captions ? Captions : CaptionsOff}
              largeIcon
              onClick={toggleCaptions}
            />
            <IconButton
              variant="overlay"
              label={fullscreen ? 'Exit full screen' : 'Full screen'}
              icon={fullscreen ? Minimize : Maximize}
              largeIcon
              onClick={toggleFullscreen}
            />
          </div>
        </div>
      )}

      {fullscreen && docked && <div className="absolute bottom-21 left-4 w-80">{docked}</div>}
    </section>
  );
}
