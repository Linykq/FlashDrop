'use client';

import type { DropSummary, PinnedDrop, Room } from '@flashdrop/contracts';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { type Cue, recentCues } from '../../lib/captions';
import { useRealtimeLevel } from '../../lib/realtime/hooks';
import { parseRoomData, topicOf } from '../../lib/realtime/protocol';
import type { AboutDrop, Show, UpNext } from '../../lib/server/show';
import { livePosition, type StreamState, streamAssets, streamState } from '../../lib/stream';
import { LiveBadge } from '../commerce/live-badge';
import { ViewerCount } from '../commerce/viewer-count';
import { DockedDropCard } from './docked-drop-card';
import { Player } from './player';
import { type ActiveCue, useCaptionsPreference } from './player-hooks';
import { AboutThisDrop, SaidCard, UpNextCard } from './room-cards';
import { RoomDropCard, type RoomPurchase } from './room-drop-card';
import { ShowRail } from './show-rail';

type LiveRoomProps = RoomPurchase & {
  room: Room;
  /** The drop the room was pinned to when the page rendered, with its stock; `null` when none. */
  drop: DropSummary | null;
  /** The stream's products in order, and its captions; `null` when they can't be read. */
  show: Show | null;
  about: AboutDrop | null;
  upNext: UpNext | null;
};

/** Lines kept for "What's being said". */
const SAID_LINES = 3;

/** The loop is at least as long as its captions: the sample's last cue ends 0.7 s before its 48 s. */
function loopLength(cues: readonly Cue[]): number {
  return Math.ceil(Math.max(0, ...cues.map((cue) => cue.end)));
}

/**
 * Where the stream is when the page renders, from the server's clock, so the room starts with the product on
 * screen and the lines just said before the player has played a frame (or at all, under reduced motion).
 */
function startingCues(show: Show | null, serverNow: number): ActiveCue[] {
  if (!show) return [];
  const position = livePosition(serverNow, loopLength(show.cues));
  return recentCues(show.cues, position, SAID_LINES).map((cue) => ({
    id: cue.id,
    text: cue.lines.join(' '),
  }));
}

/**
 * The live room (design-system §10.3, SD §7, §8.1): the player and its overlay, the room's title and what is
 * on screen, the pinned drop's card, the show's products, the pinned product's highlights, the drops up next,
 * and what is being said. From 1069 px the player's column (8) holds the title, the show and the highlights,
 * and the side column (4) the drop card, the drops up next and the captions card. Below, one column: the
 * drop card right under the title, then the show, the highlights and the drops up next; no captions card,
 * since the player's own captions are right above.
 *
 * The `room:<roomId>` topic brings the pinned drop and the viewer count across every gateway instance; when
 * it names a drop other than the one the page shows, the page asks the server for itself again, which
 * re-renders the card in place (the player keeps playing). The topic and the page read the pinned drop the same
 * way (api's `RoomReader`), so they converge. The stream's cues name the product on screen: when it isn't the
 * pinned one, a link under the title says what it is, so a buyer always knows what is being sold.
 */
export function LiveRoom({ room, drop, show, about, upNext, ...purchase }: LiveRoomProps) {
  const router = useRouter();
  const level = useRealtimeLevel(topicOf('room', room.id), parseRoomData);
  const shown: PinnedDrop | null = drop && { dropId: drop.id, status: drop.status };
  const pinned = level === null ? shown : level.data.pinned;
  const [captions, toggleCaptions] = useCaptionsPreference();
  const [said, setSaid] = useState(() => startingCues(show, purchase.serverNow));
  const onScreen = said.at(-1)?.id ?? null;

  // One refresh per newly pinned drop: a slow refresh isn't asked for again by the next frame.
  const refreshedFor = useRef<string | null | undefined>(undefined);
  const pinnedId = pinned?.dropId ?? null;
  const shownId = shown?.dropId ?? null;
  useEffect(() => {
    if (pinnedId === shownId || pinnedId === refreshedFor.current) return;
    refreshedFor.current = pinnedId;
    router.refresh();
  }, [pinnedId, shownId, router]);

  const status = pinned?.status ?? null;
  const state = streamState(status);
  const viewers = level?.data.viewers ?? null;
  const pinnedOnScreen = state === 'live' && drop !== null && onScreen === drop.product.slug;
  const elsewhere =
    state === 'live' && !pinnedOnScreen
      ? show?.segments.find((segment) => segment.slug === onScreen)
      : undefined;

  const upNextCard = (className: string) =>
    upNext && (
      <UpNextCard
        className={className}
        upNext={upNext}
        roomTitle={room.title}
        serverNow={purchase.serverNow}
      />
    );

  return (
    <div className="pb-12 sm:page-wide sm:pt-6 md:grid md:grid-cols-12 md:grid-rows-[auto_auto_auto_1fr] md:gap-x-(--grid-gap) md:pt-8 md:pb-16">
      <div className="md:col-span-8 md:row-start-1">
        <Player
          className="sm:rounded-xl"
          stream={streamAssets(room.hlsUrl)}
          state={state}
          serverNow={purchase.serverNow}
          captions={captions}
          onToggleCaptions={toggleCaptions}
          // The first cue played is often the one the page started on: each line once.
          onCue={(cue) =>
            setSaid((lines) => (lines.at(-1)?.id === cue.id ? lines : [...lines, cue].slice(-SAID_LINES)))
          }
          badges={
            <>
              {status === 'LIVE' && <LiveBadge pulse />}
              {viewers !== null && <ViewerCount count={viewers} onVideo />}
            </>
          }
          docked={drop && <DockedDropCard drop={drop} {...purchase} />}
        />
      </div>
      <div className="max-sm:page-wide mt-4 sm:mt-5 md:col-span-8 md:row-start-2">
        <h1 className="text-title-2">{room.title}</h1>
        <p className="mt-1 text-footnote text-label-secondary">
          <StreamLine state={state} />
          {state === 'live' && ' · Captions available'}
        </p>
        {/* A reserved line while the stream plays, so the link coming and going never moves the page. */}
        {state === 'live' && (
          <p className="mt-3 flex min-h-8 items-center">
            {elsewhere && (
              <Link
                key={elsewhere.slug}
                href={elsewhere.href}
                className="inline-flex h-8 max-w-full animate-fade-in items-center gap-1 rounded-full bg-fill-tertiary px-3 text-footnote font-medium text-label"
              >
                <span className="truncate">On screen: {elsewhere.title}</span>
                <ChevronRight size={14} className="shrink-0" />
              </Link>
            )}
          </p>
        )}
      </div>
      {/* The side column from 1069 px: the drop card, then what comes next and what is said. Below, only the
          drop card stays here, right under the title; the rest follows the show. */}
      <div className="max-sm:page-wide mt-6 flex flex-col gap-6 sm:max-w-form md:col-span-4 md:col-start-9 md:row-span-4 md:row-start-1 md:mt-0 md:max-w-none md:self-start">
        <RoomDropCard drop={drop} onScreen={pinnedOnScreen} {...purchase} />
        {upNextCard('max-md:hidden')}
        {state === 'live' && said.length > 0 && (
          <SaidCard
            className="max-md:hidden"
            lines={said.map((cue) => cue.text)}
            captions={captions}
            onToggleCaptions={toggleCaptions}
          />
        )}
      </div>
      {show && (
        <ShowRail
          className="max-sm:page-wide mt-10 md:col-span-8 md:row-start-3"
          segments={show.segments}
          onScreen={state === 'live' ? onScreen : null}
        />
      )}
      {about && (
        <AboutThisDrop className="max-sm:page-wide mt-10 md:col-span-8 md:row-start-4" about={about} />
      )}
      {upNextCard('max-sm:page-wide mt-10 sm:max-w-form md:hidden')}
    </div>
  );
}

/** What the stream is doing, under the room's title. Before it starts the drop card's countdown says when. */
function StreamLine({ state }: { state: StreamState }) {
  switch (state) {
    case 'live':
      return 'Live now';
    case 'ended':
      return 'Stream ended';
    case 'upcoming':
      return 'Off air';
  }
}
