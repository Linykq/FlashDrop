'use client';

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
  type RefObject,
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
import { livePosition, type StreamAssets, type StreamState } from '../../lib/stream';
import { useMediaQuery } from '../../lib/use-media-query';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import {
  type ActiveCue,
  useBehindLive,
  useCueChange,
  useFullscreen,
  useHlsAttachment,
  useIdleControls,
  usePlayback,
} from './player-hooks';

export type PlayerProps = {
  stream: StreamAssets;
  state: StreamState;
  /** The server's clock when the page rendered (epoch ms): where the loop is live until the socket says. */
  serverNow: number;
  /** The LIVE badge and the viewer count, over the top-left corner. */
  badges: ReactNode;
  /** The drop card, docked over the video while the player is fullscreen (design-system §9.12). */
  docked: ReactNode;
  /** Captions on, the room's state (`useCaptionsPreference`), and its toggle. */
  captions: boolean;
  onToggleCaptions: () => void;
  /** Each new cue as it starts: the product on screen and what is said (SD §8.1). */
  onCue?: (cue: ActiveCue) => void;
  className?: string;
};

/** Captions clear the capsules while they show: 16 px inset + 52 px capsule + 16 px gap (§10.3). */
const CAPTIONS_ABOVE_CONTROLS_PX = 84;
/** With the capsules hidden, captions keep their 16 px inset from the bottom edge. */
const CAPTIONS_INSET_PX = 16;
/**
 * Chrome's cue line as a share of the video's height: its captions are 5% of the height, at a line height of
 * about 1.2. Chrome has no `lineAlign`, so `line` places a cue box's top, and the box's height is estimated.
 */
const CUE_LINE_SHARE = 0.06;

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

/**
 * Captions sit above the capsules while they show, at the capsules' inset otherwise, and where the browser puts
 * them in iPhone's own fullscreen. Cues load after the player mounts (the track's `load`), and the share of
 * the height changes with the player's size, so both place them again.
 */
function useCuePlacement(
  video: RefObject<HTMLVideoElement | null>,
  track: RefObject<HTMLTrackElement | null>,
  { controlsShown, captions }: { controlsShown: boolean; captions: boolean },
): void {
  // iPhone's own video fullscreen: its controls, not the page's, so captions go back to the browser's place.
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const placed = useRef('');
  const place = useEffectEvent(() => {
    const element = video.current;
    const cues = element?.textTracks[0];
    if (!element || !cues?.cues) return;
    const bottom = nativeFullscreen ? null : controlsShown ? CAPTIONS_ABOVE_CONTROLS_PX : CAPTIONS_INSET_PX;
    // Only when the place changed: adding a cue again redraws it.
    const key = `${bottom}:${element.clientHeight}:${cues.cues.length}`;
    if (placed.current === key) return;
    placed.current = key;
    placeCues(cues, element.clientHeight, bottom);
  });
  useEffect(() => {
    place();
  }, [controlsShown, nativeFullscreen, captions]);
  useEffect(() => {
    const element = video.current;
    const trackElement = track.current;
    if (!element || !trackElement) return;
    const onPlace = () => place();
    const begin = () => setNativeFullscreen(true);
    const end = () => setNativeFullscreen(false);
    trackElement.addEventListener('load', onPlace);
    element.addEventListener('webkitbeginfullscreen', begin);
    element.addEventListener('webkitendfullscreen', end);
    const observer = new ResizeObserver(onPlace);
    observer.observe(element);
    return () => {
      trackElement.removeEventListener('load', onPlace);
      element.removeEventListener('webkitbeginfullscreen', begin);
      element.removeEventListener('webkitendfullscreen', end);
      observer.disconnect();
    };
  }, [video, track]);
}

/**
 * The live room's player (design-system §10.3, SD §8.1): hls.js, or the browser's own HLS where it has one
 * (Safari), playing the room's stream muted and inline, with the WebVTT captions track. The server renders it
 * whole, poster first (the page's largest paint, so it is preloaded). The sample stream is a VOD loop, so the
 * player seeks to the point every viewer shares (`livePosition`) and offers "Live" when the viewer fell behind
 * it. Under reduced motion it doesn't start by itself: the poster says "Press play to watch live" (§6.5).
 *
 * Two capsules of overlay buttons sit at the bottom corners and fade after 3 s without pointer movement
 * while playing, never while focus is inside the player; captions move up to clear them while they show.
 * Single-key shortcuts work only while the player itself has focus (WCAG 2.1.4): Space or K play and pause,
 * M mutes, C toggles captions, F fullscreen. They are exposed as `aria-keyshortcuts` and described, and the
 * player is a tab stop only while there is something to play. Controls that remove themselves when pressed
 * (the unmute pill, Live, Retry, Play) hand focus to the player first, so it never falls to the page.
 * Before and after the drop the poster says the stream starts soon or has ended; a stream that can't play
 * says so with a Retry, and the drop card beside it keeps selling either way.
 */
export function Player({
  stream,
  state,
  serverNow,
  badges,
  docked,
  captions,
  onToggleCaptions,
  onCue,
  className,
}: PlayerProps) {
  preload(stream.poster, { as: 'image', fetchPriority: 'high' });
  const container = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const captionTrack = useRef<HTMLTrackElement>(null);
  const keysId = useId();
  // Server minus device, as estimated from the render; the socket's hello refines it (`serverClockNow`).
  const [fallbackOffset] = useState(() => serverNow - Date.now());
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [unmutedOnce, setUnmutedOnce] = useState(false);
  const [startedOnce, setStartedOnce] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const calm = useMediaQuery('(prefers-reduced-motion: reduce)');
  const live = state === 'live' && !failed;
  const { playing, muted } = usePlayback(video);
  const idle = useIdleControls();
  const { fullscreen, toggle: toggleFullscreen } = useFullscreen(container, video);
  const behind = useBehindLive(video, live, fallbackOffset);
  useCueChange(video, (cue) => onCue?.(cue));

  const seekToLive = useCallback(() => {
    const element = video.current;
    if (!element || !Number.isFinite(element.duration)) return null;
    element.currentTime = livePosition(serverClockNow(fallbackOffset), element.duration);
    return element;
  }, [fallbackOffset]);
  const goLive = useCallback(() => {
    void seekToLive()
      ?.play()
      .catch(() => undefined);
  }, [seekToLive]);

  useHlsAttachment({
    video,
    src: stream.src,
    enabled: state === 'live',
    attempt,
    onFatal: () => setFailed(true),
    // Every viewer shares the live point. Muted autoplay starts there, unless reduced motion is asked for.
    onLoaded: () => {
      if (calm) seekToLive();
      else goLive();
    },
    livePoint: (duration) => livePosition(serverClockNow(fallbackOffset), duration),
  });

  useEffect(() => {
    if (playing) setStartedOnce(true);
  }, [playing]);

  useEffect(() => {
    const track = video.current?.textTracks[0];
    if (track) track.mode = captions ? 'showing' : 'hidden';
  }, [captions]);

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
  const retry = () => {
    setFailed(false);
    setAttempt((count) => count + 1);
  };
  // The unmute pill, Live, Play and Retry leave once pressed: focus moves to the player first, if they had it,
  // or it would fall to <body> (WCAG 2.4.3), and the capsules, still counting focus as inside, would never fade.
  const keepFocus = (event: MouseEvent<HTMLElement>) => {
    if (document.activeElement === event.currentTarget) container.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Only on the player itself: on a focused control, Space and Enter belong to that control (§10.3).
    if (event.target !== event.currentTarget || !live) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const action = shortcut(event.key);
    if (action === null) return;
    event.preventDefault();
    ({ play: togglePlay, mute: toggleMute, captions: onToggleCaptions, fullscreen: toggleFullscreen })[
      action
    ]();
  };

  const controlsShown = live && (!playing || idle.active || focusWithin);
  useCuePlacement(video, captionTrack, { controlsShown, captions });

  const awaitingPlay = live && calm && !startedOnce;
  const message =
    state === 'upcoming'
      ? 'The stream starts soon.'
      : state === 'ended'
        ? 'The stream has ended.'
        : failed
          ? "The stream can't play right now."
          : awaitingPlay
            ? 'Press play to watch live.'
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
      onPointerMove={idle.poke}
      onPointerDown={idle.poke}
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
      {/* Started from script once the stream is loaded (`onLoaded`), so reduced motion can keep it still. */}
      <video
        ref={video}
        poster={stream.poster}
        className="absolute inset-0 size-full object-cover in-[:fullscreen]:object-contain"
        muted
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
          {/* "Tap" only where the pointer is a finger; CSS decides, so the server render needs no guess. */}
          <span className="pointer-fine:hidden">Tap to unmute</span>
          <span className="hidden pointer-fine:inline">Unmute</span>
        </button>
      )}

      {message && (
        <div className="absolute inset-0 grid place-items-center p-4">
          <div className="material-overlay flex max-w-80 animate-fade-in flex-col items-center gap-3 rounded-lg px-5 py-4 text-center">
            <p className="inline-flex items-center gap-2 text-callout">
              {!awaitingPlay && <VideoOff size={20} className="shrink-0" />}
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
            {awaitingPlay && (
              <Button
                size="md"
                icon={Play}
                onClick={(event) => {
                  keepFocus(event);
                  goLive();
                }}
              >
                Play
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
            {behind && !awaitingPlay && (
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
              onClick={onToggleCaptions}
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
