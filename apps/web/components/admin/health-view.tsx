'use client';

import {
  type AdminHealthResponse,
  AdminHealthResponse as AdminHealthSchema,
  type InvariantCheck,
} from '@flashdrop/contracts';
import { ChevronRight, CircleCheck, CircleDashed, CircleX } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useServerTime } from '../../lib/clock';
import { formatCount, plural, shortId } from '../../lib/format';
import { useMediaQuery } from '../../lib/use-media-query';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { Skeleton, SkeletonText } from '../ui/skeleton';
import { DropStatusPill, StatusPill } from '../ui/status-pill';
import { ShortDateTime } from './admin-time';
import { DataTable, Td, Th } from './data-table';
import { formatLagSeconds, formatShortDuration } from './format';
import {
  countHealth,
  deadLetterLine,
  driftHealth,
  EMPTY_LAG,
  featuredDrops,
  groupHealth,
  type HealthSummary,
  type LagTracker,
  outboxHealth,
  type PipelineCheck,
  rebuildHealth,
  type SummaryLine,
  splitSkippedNote,
  summarizeHealth,
  trackLag,
  worst,
} from './health-model';
import { HealthPill } from './health-pill';
import { PageHeader } from './page-header';
import { ProductThumb } from './product-thumb';
import { StatTile } from './stat-tile';
import { usePoll } from './use-poll';

/** A tracked drop's product, as the drops list knows it (§10.8): what tells the rows apart. */
export type TrackedProduct = { title: string; imageKey: string | null };

/** design system §10.11: the page polls `GET /admin/health` every 5 s. */
const POLL_MS = 5_000;
const DRIFT_SAMPLES = 4;

type Polled = {
  data: AdminHealthResponse;
  lag: LagTracker;
  /** Each tracked drop's last drift samples, to judge two stable samples in a row. */
  drift: ReadonlyMap<string, readonly (number | null)[]>;
};

function foldDrift(
  history: ReadonlyMap<string, readonly (number | null)[]>,
  data: AdminHealthResponse,
): ReadonlyMap<string, readonly (number | null)[]> {
  return new Map(
    data.drops.map((drop) => [
      drop.dropId,
      [...(history.get(drop.dropId) ?? []), drop.redisDriftUnits].slice(-DRIFT_SAMPLES),
    ]),
  );
}

/**
 * Operational health (design system §10.11): the live invariant checks of `verify:invariants` (SD §1.1) and
 * the pipeline tiles, polled every 5 s with "Pause updates" (WCAG 2.2.2). The thresholds match the alerts of
 * SD §12. Nothing here is announced: the summary banner is read with the page.
 */
export function HealthView({
  initial,
  products,
}: {
  initial: AdminHealthResponse;
  /** By drop id; test drops, which the drops list leaves out, have none and show their id alone. */
  products: Readonly<Record<string, TrackedProduct>>;
}) {
  const [polled, setPolled] = useState<Polled>(() => ({
    data: initial,
    lag: trackLag(EMPTY_LAG, initial.events.consumers, Date.parse(initial.checkedAt)),
    drift: foldDrift(new Map(), initial),
  }));
  const [paused, setPaused] = useState(false);
  const now = useServerTime(Date.parse(initial.checkedAt));

  const { failed } = usePoll({
    url: '/api/v1/admin/health',
    schema: AdminHealthSchema,
    intervalMs: POLL_MS,
    enabled: !paused,
    onData: (data) =>
      setPolled((previous) => ({
        data,
        lag: trackLag(previous.lag, data.events.consumers, Date.parse(data.checkedAt)),
        drift: foldDrift(previous.drift, data),
      })),
  });

  const { data } = polled;
  const age = Math.max(0, Math.round((now - Date.parse(data.checkedAt)) / 1000));
  const pipeline = pipelineChecks(polled);

  return (
    <>
      <PageHeader
        title="Health"
        actions={
          <Button variant="plain" size="sm" aria-pressed={paused} onClick={() => setPaused(!paused)}>
            Pause updates
          </Button>
        }
      >
        <p className="mt-2 text-footnote text-label-secondary tabular-nums">
          {paused ? 'Updates paused · ' : ''}
          Updated {age < 2 ? 'just now' : `${formatShortDuration(age)} ago`}
          {failed && !paused ? ' · The last check didn’t answer' : ''}
        </p>
      </PageHeader>
      <Summary summary={summarizeHealth(data.invariants, data.unavailable, pipeline)} />
      <Invariants invariants={data.invariants} checkedAt={data.checkedAt} />
      <Tiles polled={polled} pipeline={pipeline} />
      <TrackedDrops polled={polled} products={products} />
    </>
  );
}

const anchor = (id: string) => `invariant-${id.toLowerCase()}`;
const tileAnchor = (id: string) => `pipeline-${id}`;

/**
 * The summary of every check on the page (§10.11), with links to the rows and tiles it names: the most severe
 * problem as the headline, the rest under it. All healthy is one line.
 */
function Summary({ summary }: { summary: HealthSummary }) {
  return (
    <Banner tone={summary.tone} title={summary.title && <Line line={summary.title} />} className="mt-6">
      {summary.lines.length > 0 &&
        summary.lines.map((line) => (
          <p key={line.text}>
            <Line line={line} />
          </p>
        ))}
    </Banner>
  );
}

function Line({ line }: { line: SummaryLine }) {
  return (
    <>
      {line.text}
      {line.targets.map((target, index) => (
        <span key={`${target.kind}:${target.id}`}>
          {index === 0 ? ' ' : ', '}
          <a
            href={`#${target.kind === 'invariant' ? anchor(target.id) : tileAnchor(target.id)}`}
            className="underline underline-offset-4"
          >
            {target.label}
          </a>
        </span>
      ))}
      {line.targets.length > 0 && '.'}
    </>
  );
}

/** Each pipeline tile's verdict, as its pill shows it and the summary counts it (§10.11 thresholds). */
function pipelineChecks({ data, lag, drift }: Polled): PipelineCheck[] {
  const at = Date.parse(data.checkedAt);
  const consumers = data.events.consumers;
  const rebuilding = data.drops.flatMap((drop) =>
    drop.rebuildingSince === null ? [] : [drop.rebuildingSince],
  );
  return [
    { id: 'outbox', label: 'Outbox lag', level: outboxHealth(data.events.outbox.oldestSeconds) },
    {
      id: 'consumers',
      label: 'Consumer lag',
      level:
        consumers === null ? 'unknown' : worst(consumers.map((group) => groupHealth(lag, group.name, at))),
    },
    {
      id: 'drift',
      label: 'Redis drift',
      level:
        data.drops.length === 0
          ? 'healthy'
          : worst(data.drops.map((drop) => driftHealth(drift.get(drop.dropId) ?? []))),
    },
    { id: 'dead-letters', label: 'Dead letters', level: countHealth(data.events.deadLetters) },
    { id: 'quarantine', label: 'Sweeper quarantine', level: countHealth(data.quarantined) },
    { id: 'rebuilding', label: 'Drops rebuilding', level: rebuildHealth(rebuilding, at) },
  ];
}

const INVARIANT_PILL = {
  holds: { tone: 'success', icon: CircleCheck, label: 'Holds' },
  breached: { tone: 'danger', icon: CircleX, label: 'Breached' },
  unchecked: { tone: 'neutral', icon: CircleDashed, label: 'Unchecked' },
} as const;

/**
 * The invariants (§10.11): a table from 735 px; on a phone, where nine rows of four columns only scrolled
 * sideways with every name cut, a list of the same rows, name and verdict first. Both are rendered and CSS
 * shows one; the summary's anchors sit on the one in view, the table's during the server render.
 */
function Invariants({ invariants, checkedAt }: { invariants: readonly InvariantCheck[]; checkedAt: string }) {
  const phone = useMediaQuery('(width < 735px)');
  const { checks, skipped } = splitSkippedNote(invariants);
  return (
    // A plain box under its heading: the table's region and the list carry the same name.
    <div className="mt-8">
      <h2 className="text-title-3">Invariants</h2>
      <DataTable id="invariants-table" caption="Invariants" className="mt-4 max-sm:hidden">
        <thead>
          <tr>
            <Th first>Id</Th>
            <Th>Status</Th>
            <Th>Invariant</Th>
            <Th last>Checked</Th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => (
            <tr key={check.id} id={phone ? undefined : anchor(check.id)} className="scroll-mt-24">
              <Td first className="whitespace-nowrap font-mono text-footnote">
                {check.id}
              </Td>
              <Td>
                <InvariantPill status={check.status} />
              </Td>
              <Td className="min-w-72">
                <p className="font-medium">{check.title}</p>
                <InvariantDetail check={check} />
              </Td>
              <Td last className="whitespace-nowrap text-label-secondary">
                <ShortDateTime iso={checkedAt} />
              </Td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <ul
        aria-label="Invariants"
        className="mt-4 divide-y divide-separator rounded-lg bg-surface elevation-1 sm:hidden"
      >
        {checks.map((check) => (
          <li key={check.id} id={phone ? anchor(check.id) : undefined} className="scroll-mt-24 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-callout font-medium">{check.title}</p>
              <InvariantPill status={check.status} />
            </div>
            <InvariantDetail check={check} />
            <p className="mt-1 text-footnote text-label-secondary">
              <span className="font-mono">{check.id}</span> · <ShortDateTime iso={checkedAt} />
            </p>
          </li>
        ))}
      </ul>
      {skipped > 0 && (
        <p className="mt-3 text-footnote text-label-secondary">
          {formatCount(skipped)} ended test {plural(skipped, 'drop wasn’t', 'drops weren’t')} sampled.
        </p>
      )}
    </div>
  );
}

function InvariantPill({ status }: { status: InvariantCheck['status'] }) {
  const pill = INVARIANT_PILL[status];
  return (
    <StatusPill tone={pill.tone} icon={pill.icon}>
      {pill.label}
    </StatusPill>
  );
}

/** What was checked, then the first breaches, each linked to its drop. */
function InvariantDetail({ check }: { check: InvariantCheck }) {
  return (
    <>
      <p className="text-footnote text-label-secondary">{check.detail}</p>
      {check.violations.length > 0 && (
        <ul className="mt-1 text-footnote text-danger">
          {check.violations.map((violation, index) => (
            <li key={`${violation.dropId ?? violation.orderId ?? ''}:${index}`}>
              {violation.dropId ? (
                <Link href={`/admin/drops/${violation.dropId}`} className="underline underline-offset-4">
                  {violation.message}
                </Link>
              ) : (
                violation.message
              )}
            </li>
          ))}
          {check.moreViolations > 0 && <li>and {formatCount(check.moreViolations)} more</li>}
        </ul>
      )}
    </>
  );
}

function Tiles({ polled, pipeline }: { polled: Polled; pipeline: readonly PipelineCheck[] }) {
  const { data } = polled;
  const consumers = data.events.consumers;
  const drifting = data.drops.filter((drop) => drop.redisDriftUnits !== null && drop.redisDriftUnits !== 0);
  const rebuilding = data.drops.filter((drop) => drop.rebuildingSince !== null).length;
  // A check's tile: its anchor, which the summary links to, and its pill.
  const tile = (id: string) => ({
    id: tileAnchor(id),
    className: 'scroll-mt-24',
    status: <HealthPill level={pipeline.find((check) => check.id === id)?.level ?? 'unknown'} />,
  });

  return (
    <section aria-labelledby="pipeline" className="@container mt-10">
      <h2 id="pipeline" className="text-title-3">
        Pipeline
      </h2>
      {/* Two up on a phone, like the dashboard's totals; a narrow tile's pill goes under its label. */}
      <div className="mt-4 grid grid-cols-2 gap-(--grid-gap) @content:grid-cols-3">
        <StatTile
          {...tile('outbox')}
          label="Outbox lag"
          value={formatLagSeconds(data.events.outbox.oldestSeconds ?? 0)}
          sub={
            data.events.outbox.pending === 0
              ? 'Nothing pending'
              : `${formatCount(data.events.outbox.pending)} pending`
          }
        />
        <StatTile
          {...tile('consumers')}
          label="Consumer lag"
          value={consumers === null ? '—' : formatCount(consumers.reduce((sum, group) => sum + group.lag, 0))}
          sub={
            consumers === null
              ? "Kafka didn't answer"
              : consumers.map((group) => `${group.name} ${formatCount(group.lag)}`).join(' · ')
          }
        />
        <StatTile
          {...tile('drift')}
          label="Redis drift"
          value={`${formatCount(drifting.length)} ${drifting.length === 1 ? 'drop' : 'drops'}`}
          sub={`of ${formatCount(data.drops.length)} tracked`}
        />
        <StatTile
          {...tile('dead-letters')}
          label="Dead letters"
          value={data.events.deadLetters === null ? '—' : formatCount(data.events.deadLetters)}
          sub={deadLetterLine(data.events.deadLettersRetained)}
        />
        <StatTile
          {...tile('quarantine')}
          label="Sweeper quarantine"
          value={formatCount(data.quarantined)}
          sub="orders a sweeper gave up on"
        />
        <StatTile
          {...tile('rebuilding')}
          label="Drops rebuilding"
          value={formatCount(rebuilding)}
          sub="live stock rebuilt from Postgres"
        />
      </div>
    </section>
  );
}

/**
 * The tracked drops (armed, until a day after they end), with links to each one's page and dashboard: the way
 * to a test drop's dashboard during a load run, since test drops stay out of the drops list. Drops that need a
 * look come first, then open ones; idle drops that ended wait behind "Show all", as load runs leave hundreds.
 */
function TrackedDrops({
  polled,
  products,
}: {
  polled: Polled;
  products: Readonly<Record<string, TrackedProduct>>;
}) {
  const { drops } = polled.data;
  const [all, setAll] = useState(false);
  const { featured, rest } = featuredDrops(drops);
  const shown = all ? [...featured, ...rest] : featured;
  return (
    <div className="mt-10">
      <h2 className="text-title-3">Tracked drops</h2>
      <p className="mt-1 text-callout text-label-secondary">
        Armed drops, until a day after they end. Equality checks run on idle ones.
      </p>
      {shown.length === 0 ? (
        <p className="mt-4 rounded-lg bg-surface p-5 text-callout text-label-secondary elevation-1">
          {drops.length === 0
            ? 'No drops are tracked right now.'
            : `All ${formatCount(drops.length)} tracked drops ended and are idle.`}
        </p>
      ) : (
        <DataTable id="tracked-table" caption="Tracked drops" className="mt-4">
          <thead>
            <tr>
              <Th first>Drop</Th>
              <Th>Status</Th>
              <Th>Work owed</Th>
              <Th numeric>Drift</Th>
              <Th last>
                <span className="sr-only">Dashboard</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((drop) => {
              const product = products[drop.dropId];
              return (
                <tr key={drop.dropId}>
                  <Td first className="sm:min-w-64">
                    {/* The drops table's product cell (§10.8), with the short id under the title, since one
                      product can have several drops; a test drop has its id alone. */}
                    <Link
                      href={`/admin/drops/${drop.dropId}`}
                      className="flex items-center gap-3 rounded-sm py-1 text-label hover:text-label/80"
                    >
                      <ProductThumb imageKey={product?.imageKey ?? undefined} />
                      <span className="min-w-0">
                        {product && <span className="line-clamp-2 font-medium">{product.title}</span>}
                        <span
                          title={drop.dropId}
                          className="block truncate font-mono text-footnote text-label-secondary"
                        >
                          {shortId(drop.dropId)}
                        </span>
                      </span>
                    </Link>
                  </Td>
                  <Td>
                    <DropStatusPill status={drop.rebuildingSince === null ? drop.status : 'RECONCILING'} />
                  </Td>
                  <Td className="min-w-48 text-label-secondary">
                    {drop.pending.length > 0
                      ? drop.pending.join(', ')
                      : drop.idle
                        ? 'Idle'
                        : 'Checks deferred'}
                  </Td>
                  <Td numeric>{drop.redisDriftUnits === null ? '—' : formatCount(drop.redisDriftUnits)}</Td>
                  <Td last className="whitespace-nowrap">
                    <Link
                      href={`/admin/dashboard/${drop.dropId}`}
                      className="inline-flex items-center gap-1 text-accent-label"
                    >
                      Dashboard
                      {/* Every row's link reads "Dashboard": its drop is part of its name (WCAG 2.4.4). */}
                      <span className="sr-only">
                        {' '}
                        for {product ? product.title : 'drop'} {shortId(drop.dropId)}
                      </span>
                      <ChevronRight size={14} />
                    </Link>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
      {rest.length > 0 && (
        <Button variant="plain" size="sm" aria-expanded={all} onClick={() => setAll(!all)} className="mt-3">
          {all ? 'Show fewer' : `Show all ${formatCount(drops.length)}`}
        </Button>
      )}
    </div>
  );
}

/** The page's exact box while the first check runs (§9.16). */
export function HealthSkeleton() {
  return (
    <div aria-busy="true">
      <PageHeader title="Health">
        <SkeletonText style="footnote" className="mt-2 w-32" />
      </PageHeader>
      <div aria-hidden="true">
        <Skeleton className="mt-6 h-12 rounded-md" />
        <SkeletonText style="title-3" className="mt-8 w-32" />
        <Skeleton className="mt-4 h-150 rounded-lg" />
      </div>
    </div>
  );
}
