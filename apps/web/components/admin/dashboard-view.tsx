'use client';

import {
  type AdminDashboardResponse,
  AdminDashboardResponse as AdminDashboardSchema,
  type DashboardTotals,
  type StockLevel,
} from '@flashdrop/contracts';
import { LayoutDashboard, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cx } from '../../lib/cx';
import { formatCount, formatMoney } from '../../lib/format';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Skeleton, SkeletonText } from '../ui/skeleton';
import { DropStatusPill } from '../ui/status-pill';
import { TitleText } from '../ui/title-text';
import { DropWindow, useViewerZone, zonedTime } from './admin-time';
import { ChartFrame } from './chart-frame';
import { funnel, peakMinute, sellOutSeconds, unitsPerMinute, unsoldTile } from './dashboard-model';
import {
  formatClockTime,
  formatLagSeconds,
  formatPercent,
  formatShortDuration,
  formatTileCount,
  formatTileMoney,
} from './format';
import {
  countHealth,
  deadLetterLine,
  driftHealth,
  EMPTY_LAG,
  groupHealth,
  type HealthLevel,
  type LagTracker,
  outboxHealth,
  trackLag,
  worst,
} from './health-model';
import { HealthPill } from './health-pill';
import { useLiveStock, useLiveTotals, useRealtimeStatus, type VersionedTotals } from './live';
import { PageHeader } from './page-header';
import { StatTile } from './stat-tile';
import { StockSummary } from './stock-summary';
import { usePoll } from './use-poll';

/** Health tiles and the series refresh every 5 s (design system §10.11 cadence). */
const POLL_MS = 5_000;
/** A newer totals frame refreshes the per-minute series at most this often: frames carry totals only. */
const SERIES_REFRESH_MS = 2_000;
/** Drift samples kept to judge "two stable samples in a row". */
const DRIFT_SAMPLES = 4;

/** Everything one frozen or live render shows. */
type Snapshot = {
  data: AdminDashboardResponse;
  totals: VersionedTotals;
  stock: StockLevel | null;
  lag: LagTracker;
  drift: readonly (number | null)[];
  at: number;
};

/**
 * The live sales dashboard (SD §9, design system §10.10). The first state is the server's render of
 * `GET /admin/dashboard/drops/:id`; then the page follows `dash:<dropId>` (totals, by projection version) and
 * `stock:<dropId>` (Redis levels) on the socket, and polls the same read every 5 s for the series and the
 * health tiles, sooner (at most every 2 s) when a frame shows the totals moved. "Pause updates" freezes
 * everything on screen (WCAG 2.2.2); resuming catches up to the latest. Numbers update in place; nothing is
 * announced (§13.3).
 */
export function DashboardView({ initial }: { initial: AdminDashboardResponse }) {
  const dropId = initial.drop.id;
  const [data, setData] = useState(initial);
  const [lag, setLag] = useState(() =>
    trackLag(EMPTY_LAG, initial.health.consumers, Date.parse(initial.serverNow)),
  );
  const [drift, setDrift] = useState<readonly (number | null)[]>([initial.health.redisDriftUnits]);
  const [frozen, setFrozen] = useState<Snapshot | null>(null);
  // When the shown data was read: the server's clock first, then each poll's arrival. Rendering never reads
  // the clock itself, so the server render and hydration agree.
  const [readAt, setReadAt] = useState(() => Date.parse(initial.serverNow));
  const totals = useLiveTotals(dropId, data.projection);
  const stock = useLiveStock(data.drop.status === 'DRAFT' ? null : dropId, data.stock);
  const realtime = useRealtimeStatus();

  const { refresh } = usePoll({
    url: `/api/v1/admin/dashboard/drops/${dropId}`,
    schema: AdminDashboardSchema,
    intervalMs: POLL_MS,
    enabled: frozen === null,
    onData: (next, at) => {
      setData(next);
      setReadAt(at);
      setLag((tracker) => trackLag(tracker, next.health.consumers, at));
      setDrift((samples) => [...samples, next.health.redisDriftUnits].slice(-DRIFT_SAMPLES));
    },
  });

  // A frame with newer totals than the last read: the series behind the chart moved too.
  const behind = totals.version > data.projection.version;
  useEffect(() => {
    if (!behind || frozen !== null) return;
    const timer = setTimeout(refresh, SERIES_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [behind, frozen, refresh]);

  const live: Snapshot = { data, totals, stock: stock.level, lag, drift, at: readAt };
  const shown = frozen ?? live;

  function togglePause() {
    if (frozen === null) {
      setFrozen({ ...live, at: Date.now() });
      return;
    }
    // Polling resumes with a read at once (`usePoll`), and the socket's levels never stopped.
    setFrozen(null);
  }

  return (
    <>
      <PageHeader
        title={<TitleText text={shown.data.drop.product.title} />}
        actions={
          <Button variant="plain" size="sm" aria-pressed={frozen !== null} onClick={togglePause}>
            Pause updates
          </Button>
        }
      >
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-label-secondary">
          <DropStatusPill
            status={shown.stock?.status === 'RECONCILING' ? 'RECONCILING' : shown.data.drop.status}
          />
          <span aria-hidden="true">·</span>
          <DropWindow startsAt={shown.data.drop.startsAt} endsAt={shown.data.drop.endsAt} />
          <span aria-hidden="true">·</span>
          <UpdatesState pausedAt={frozen?.at ?? null} disconnected={realtime.paused} />
        </div>
      </PageHeader>
      <DashboardBody snapshot={shown} live={frozen === null} />
    </>
  );
}

/** "● Live updates", "Updates paused" after 5 s without a socket, or when the admin paused. */
function UpdatesState({ pausedAt, disconnected }: { pausedAt: number | null; disconnected: boolean }) {
  const zone = useViewerZone();
  if (pausedAt !== null) {
    return <span className="tabular-nums">Paused at {formatClockTime(pausedAt, zone)}</span>;
  }
  if (disconnected) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <WifiOff size={16} />
        Updates paused
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="size-2 rounded-full bg-success" />
      Live updates
    </span>
  );
}

function DashboardBody({ snapshot, live }: { snapshot: Snapshot; live: boolean }) {
  const { data, totals, stock } = snapshot;
  const { drop } = data;
  const zone = useViewerZone();
  const current = totals.totals;
  const units = unitsPerMinute(data.series, live && drop.status === 'LIVE' ? snapshot.at : null, (minute) =>
    zonedTime(minute, zone),
  );
  const peak = peakMinute(units);
  const level = stock ?? { avail: drop.total - current.unitsSold, held: 0, sold: current.unitsSold };
  const quiet = current.reserved === 0 && data.series.length === 0;

  return (
    <>
      <Tiles
        drop={drop}
        totals={current}
        avail={level.avail}
        held={level.held}
        soldOutMinute={data.soldOutMinute}
        at={snapshot.at}
      />
      <div className="mt-(--grid-gap) grid gap-(--grid-gap) md:grid-cols-12">
        {quiet ? (
          <div className="rounded-lg bg-surface elevation-1 md:col-span-8">
            <EmptyState
              icon={LayoutDashboard}
              title="No orders yet"
              description="Numbers appear as soon as the first buyer reserves."
            />
          </div>
        ) : (
          <ChartFrame
            className="md:col-span-8"
            title="Units sold per minute"
            summary={
              peak === null
                ? 'Units sold per minute: none yet.'
                : `Units sold per minute, ${units.points.length} minutes, peak ${formatCount(peak.value)} at ${peak.label}.`
            }
            spec={units}
          />
        )}
        <section
          aria-labelledby="stock-now"
          className="rounded-lg bg-surface p-5 elevation-1 sm:p-6 md:col-span-4"
        >
          <h2 id="stock-now" className="text-headline">
            Stock now
          </h2>
          <StockSummary
            avail={level.avail}
            held={level.held}
            sold={level.sold}
            total={drop.total}
            columns={2}
          />
        </section>
      </div>
      {!quiet && (
        <ChartFrame
          className="mt-(--grid-gap)"
          title="Funnel"
          description="Orders by how far they got, and how the rest ended."
          summary={`Funnel: ${formatCount(current.reserved)} reserved, ${formatCount(current.placed)} placed, ${formatCount(current.paid)} paid; ${formatCount(current.expired)} expired, ${formatCount(current.cancelled)} cancelled, ${formatCount(current.failed)} failed, ${formatCount(current.rejected)} rejected.`}
          spec={funnel(current)}
        />
      )}
      <HealthTiles snapshot={snapshot} />
      <p className="mt-6 text-footnote text-label-secondary">
        Totals are a projection of orders.v1, version {formatCount(totals.version)}.
      </p>
    </>
  );
}

function Tiles({
  drop,
  totals,
  avail,
  held,
  soldOutMinute,
  at,
}: {
  drop: AdminDashboardResponse['drop'];
  totals: DashboardTotals;
  avail: number;
  held: number;
  soldOutMinute: string | null;
  /** When the shown data was read: how long an unsold drop has been selling. */
  at: number;
}) {
  const sellOut = sellOutSeconds(drop.startsAt, soldOutMinute);
  const unsold = unsoldTile(drop, at, { avail, held });
  const exactMoney = formatMoney(totals.revenueCents, drop.currency, 'exact');
  return (
    // Five tiles need room: they take five columns only where the content is wide enough for them.
    <section aria-label="Totals" className="@container mt-8">
      <div className="grid grid-cols-2 gap-(--grid-gap) @form:grid-cols-3 @content:grid-cols-5">
        <StatTile
          label="Units sold"
          value={formatTileCount(totals.unitsSold)}
          sub={`of ${formatCount(drop.total)} units`}
        />
        <StatTile label="Sell-through" value={formatPercent(totals.unitsSold, drop.total) ?? '0.0%'} />
        <StatTile
          label="GMV"
          value={formatTileMoney(totals.revenueCents, drop.currency)}
          sub={`${exactMoney} gross`}
        />
        <StatTile
          label="Payment failures"
          value={formatPercent(totals.failed, totals.placed) ?? '—'}
          sub={`${formatCount(totals.failed)} of ${formatCount(totals.placed)} placed`}
        />
        {sellOut === null || soldOutMinute === null ? (
          <StatTile className="max-sm:col-span-2" {...unsold} />
        ) : (
          <StatTile
            className="max-sm:col-span-2"
            label="Sold out in"
            value={formatShortDuration(sellOut)}
            sub={<SoldOutBy minute={soldOutMinute} />}
          />
        )}
      </div>
    </section>
  );
}

/** The end of the minute the last unit sold in: the projection buckets by minute (SD §9). */
function SoldOutBy({ minute }: { minute: string }) {
  const zone = useViewerZone();
  return <>Sold out by {zonedTime(Date.parse(minute) + 60_000, zone)}</>;
}

function HealthTiles({ snapshot }: { snapshot: Snapshot }) {
  const { health } = snapshot.data;
  const consumers = health.consumers;
  const groupLevels = (consumers ?? []).map((group) => groupHealth(snapshot.lag, group.name, snapshot.at));
  const consumerLevel: HealthLevel = consumers === null ? 'unknown' : worst(groupLevels);
  const totalLag = consumers?.reduce((sum, group) => sum + group.lag, 0) ?? null;
  const driftLevel = driftHealth(snapshot.drift);
  const drift = health.redisDriftUnits;

  return (
    <section aria-labelledby="pipeline-health" className="@container mt-10">
      <h2 id="pipeline-health" className="text-title-3">
        Pipeline health
      </h2>
      {/* Two up on a phone, like the totals above; a narrow tile's pill goes under its label. */}
      <div className="mt-4 grid grid-cols-2 gap-(--grid-gap) @content:grid-cols-4">
        <StatTile
          label="Outbox lag"
          value={formatLagSeconds(health.outbox.oldestSeconds ?? 0)}
          sub={
            health.outbox.pending === 0 ? 'Nothing pending' : `${formatCount(health.outbox.pending)} pending`
          }
          status={<HealthPill level={outboxHealth(health.outbox.oldestSeconds)} />}
        />
        <StatTile
          label="Consumer lag"
          value={totalLag === null ? '—' : formatCount(totalLag)}
          sub={
            consumers === null
              ? "Kafka didn't answer"
              : consumers.map((group) => `${group.name} ${formatCount(group.lag)}`).join(' · ')
          }
          status={<HealthPill level={consumerLevel} />}
        />
        <StatTile
          label="Redis drift"
          value={drift === null ? '—' : `${formatCount(drift)} units`}
          sub={drift === null ? 'Not comparable right now' : 'Redis minus Postgres'}
          status={<HealthPill level={driftLevel} />}
        />
        <StatTile
          label="Dead letters"
          value={health.deadLetters === null ? '—' : formatCount(health.deadLetters)}
          sub={deadLetterLine(health.deadLettersRetained)}
          status={<HealthPill level={countHealth(health.deadLetters)} />}
        />
      </div>
    </section>
  );
}

/** The page's exact box while the first read loads (§9.16). */
export function DashboardSkeleton() {
  return (
    <div aria-busy="true">
      <div aria-hidden="true" className="pt-8 sm:pt-12">
        <SkeletonText style="title-1" className="w-80 max-w-full" />
        <SkeletonText style="footnote" className="mt-2 w-64 max-w-full" />
      </div>
      <div aria-hidden="true" className="@container mt-8">
        <div className="grid grid-cols-2 gap-(--grid-gap) @form:grid-cols-3 @content:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className={cx('h-32 rounded-lg', index === 4 && 'max-sm:col-span-2')} />
          ))}
        </div>
      </div>
      <div aria-hidden="true" className="mt-(--grid-gap) grid gap-(--grid-gap) md:grid-cols-12">
        <Skeleton className="h-87 rounded-lg md:col-span-8" />
        <Skeleton className="h-87 rounded-lg md:col-span-4" />
      </div>
    </div>
  );
}
