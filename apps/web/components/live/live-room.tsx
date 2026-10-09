'use client';

import type { DropSummary, PinnedDrop, Room } from '@flashdrop/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useRealtimeLevel } from '../../lib/realtime/hooks';
import { parseRoomData, topicOf } from '../../lib/realtime/protocol';
import { type StreamState, streamAssets, streamState } from '../../lib/stream';
import { Countdown } from '../commerce/countdown';
import { LiveBadge } from '../commerce/live-badge';
import { ViewerCount } from '../commerce/viewer-count';
import { DockedDropCard } from './docked-drop-card';
import { Player } from './player';
import { RoomDropCard, type RoomPurchase } from './room-drop-card';

type LiveRoomProps = RoomPurchase & {
  room: Room;
  /** The drop the room was pinned to when the page rendered, with its stock; `null` when none. */
  drop: DropSummary | null;
};

/**
 * The live room (design-system §10.3, SD §7, §8.1): the player and its overlay, the room's title, and the
 * pinned drop's card, beside the player from 1069 px and under it below. The `room:<roomId>` topic brings the
 * pinned drop and the viewer count across every gateway instance; when it names a drop other than the one the
 * page shows, the page asks the server for itself again, which re-renders the card in place (the player keeps
 * playing). The topic and the page read the pinned drop the same way (api's `RoomReader`), so they converge.
 */
export function LiveRoom({ room, drop, ...purchase }: LiveRoomProps) {
  const router = useRouter();
  const level = useRealtimeLevel(topicOf('room', room.id), parseRoomData);
  const shown: PinnedDrop | null = drop && { dropId: drop.id, status: drop.status };
  const pinned = level === null ? shown : level.data.pinned;

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

  return (
    <div className="pb-12 sm:page-wide sm:pt-6 md:grid md:grid-cols-12 md:items-start md:gap-(--grid-gap) md:pt-8 md:pb-16">
      <div className="md:col-span-8">
        <Player
          className="sm:rounded-xl"
          stream={streamAssets(room.hlsUrl)}
          state={state}
          serverNow={purchase.serverNow}
          badges={
            <>
              {status === 'LIVE' && <LiveBadge pulse />}
              {viewers !== null && <ViewerCount count={viewers} onVideo />}
            </>
          }
          docked={drop && <DockedDropCard drop={drop} {...purchase} />}
        />
        <div className="max-sm:page-wide mt-4 sm:mt-5">
          <h1 className="text-title-2">{room.title}</h1>
          <p className="mt-1 text-footnote text-label-secondary">
            <StreamLine state={state} drop={drop} serverNow={purchase.serverNow} />
            {' · '}Captions available
          </p>
        </div>
      </div>
      <div className="max-sm:page-wide mt-6 sm:max-w-form md:sticky md:top-[calc(env(safe-area-inset-top)+var(--nav-height)+--spacing(8))] md:col-span-4 md:mt-0 md:max-w-none">
        <RoomDropCard drop={drop} {...purchase} />
      </div>
    </div>
  );
}

/** What the stream is doing, under the room's title. */
function StreamLine({
  state,
  drop,
  serverNow,
}: {
  state: StreamState;
  drop: DropSummary | null;
  serverNow: number;
}) {
  switch (state) {
    case 'live':
      return 'Live now';
    case 'ended':
      return 'Stream ended';
    case 'upcoming':
      // Nothing pinned: no drop, so no time to give.
      return drop ? <Countdown target={drop.startsAt} serverNow={serverNow} verb="Starts" /> : 'Off air';
  }
}
