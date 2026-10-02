import {
  CalendarClock,
  ChevronRight,
  CircleCheck,
  CircleX,
  Copy,
  Layers,
  LogOut,
  Play,
  Sparkles,
  Trash,
  TriangleAlert,
} from 'lucide-react';
import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { type ReactNode, Suspense } from 'react';
import candle from '../../../../../../assets/catalog/amber-jar-candle/2.jpg';
import parfum from '../../../../../../assets/catalog/faceted-eau-de-parfum/1.jpg';
import shirt from '../../../../../../assets/catalog/linen-band-collar-shirt/1.jpg';
import vase from '../../../../../../assets/catalog/ring-stoneware-vase/1.jpg';
import headphones from '../../../../../../assets/catalog/sage-wireless-headphones/1.jpg';
import mugs from '../../../../../../assets/catalog/stone-charcoal-mug-set/2.jpg';
import { Countdown } from '../../../../components/commerce/countdown';
import { DropCard, DropCardEmpty } from '../../../../components/commerce/drop-card';
import { LiveBadge } from '../../../../components/commerce/live-badge';
import { LocalTime } from '../../../../components/commerce/local-time';
import { Price } from '../../../../components/commerce/price';
import { ProductTile, ProductTileSkeleton } from '../../../../components/commerce/product-tile';
import { StockMeter } from '../../../../components/commerce/stock-meter';
import { StockText } from '../../../../components/commerce/stock-text';
import { ViewerCount } from '../../../../components/commerce/viewer-count';
import { NavigationBar } from '../../../../components/layout/nav-bar';
import { Avatar } from '../../../../components/ui/avatar';
import { Banner } from '../../../../components/ui/banner';
import { Button, ButtonLink } from '../../../../components/ui/button';
import { EmptyState } from '../../../../components/ui/empty-state';
import { IconButton } from '../../../../components/ui/icon-button';
import { Skeleton, SkeletonText } from '../../../../components/ui/skeleton';
import {
  DropStatusPill,
  ListingJobStatusPill,
  OrderStatusPill,
  StatusPill,
} from '../../../../components/ui/status-pill';
import { cx } from '../../../../lib/cx';
import type { StockState } from '../../../../lib/stock';
import {
  DialogDemo,
  DismissibleBanner,
  MuteToggle,
  PurchaseRow,
  SegmentedDemo,
  SheetDemo,
  StepperDemo,
  ToastDemo,
} from './demos';

export const metadata: Metadata = {
  title: 'Components',
  robots: { index: false, follow: false },
};

/**
 * The design system's primitives in every state, for visual review in light and dark at every width
 * (design-system §15), in `pnpm dev` only: a production build answers 404 here, so the gallery is never
 * served by the deployed store. Not linked from the store and not indexed.
 */
export default function ComponentsPage() {
  // Replaced at build time, so production prerenders this route as the not-found page.
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <div className="page-wide py-(--section-space)">
      <h1 className="text-title-1">Components</h1>
      <p className="mt-4 max-w-text text-intro text-label-secondary">
        Every primitive of the FlashDrop design system in every state. Switch the appearance in the footer and
        resize the window to review them in light, dark and at every width.
      </p>
      <Suspense fallback={<Skeleton className="mt-16 h-dvh rounded-xl" />}>
        <Gallery />
      </Suspense>
    </div>
  );
}

// Countdowns need a real "now", so the gallery renders per request and never at build time.
async function Gallery() {
  await connection();
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms).toISOString();
  const minute = 60_000;
  const hour = 60 * minute;

  const stock = {
    live: { status: 'LIVE', avail: 488, held: 4, sold: 8 },
    urgent: { status: 'LIVE', avail: 12, held: 3, sold: 485 },
    reserved: { status: 'LIVE', avail: 0, held: 3, sold: 497 },
    soldOut: { status: 'LIVE', avail: 0, held: 0, sold: 500 },
    scheduled: { status: 'SCHEDULED', avail: 500, held: 0, sold: 0 },
    paused: { status: 'PAUSED', avail: 20, held: 2, sold: 478 },
    ended: { status: 'ENDED', avail: 18, held: 0, sold: 482 },
  } as const satisfies Record<string, StockState>;

  const drop = {
    perUserLimit: 2,
    holdSeconds: 120,
    startsAt: at(2 * hour + 14 * minute + 9_000),
    endsAt: at(12 * minute + 4_000),
    serverNow: now,
    currency: 'USD',
  };

  return (
    <>
      <Section title="Colour" description="Semantic tokens only. Every one has a light and a dark value.">
        <SwatchGroup title="Surfaces" swatches={surfaceSwatches} />
        <SwatchGroup title="Fills" swatches={fillSwatches} />
        <SwatchGroup title="Labels and lines" swatches={labelSwatches} />
        <SwatchGroup title="Accent, live and status" swatches={accentSwatches} />
        <SwatchGroup title="Charts" swatches={chartSwatches} />
      </Section>

      <Section
        title="Typography"
        description="Eleven styles. Size, line height, weight and tracking in one class."
      >
        <div className="flex flex-col divide-y divide-separator">
          {typeStyles.map(({ name, className, sample }) => (
            <div
              key={name}
              className="grid gap-1 py-4 sm:grid-cols-[--spacing(40)_1fr] sm:items-baseline sm:gap-6"
            >
              <span className="text-footnote text-label-secondary">{name}</span>
              <span className={className}>{sample}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Buttons" description="One filled button per region. Buttons never scale when pressed.">
        <div className="flex flex-col gap-10">
          {(['lg', 'md', 'sm'] as const).map((size) => (
            <Specimen key={size} label={`Size ${size}`}>
              <Row>
                <Button size={size}>Buy</Button>
                <Button size={size} variant="tinted" icon={Play}>
                  Watch live
                </Button>
                <Button size={size} variant="gray">
                  Edit
                </Button>
                <Button size={size} variant="plain" trailingIcon={ChevronRight}>
                  Looks right
                </Button>
              </Row>
            </Specimen>
          ))}
          <Specimen label="Tones: destructive and neutral">
            <Row>
              <Button variant="tinted" tone="destructive" icon={Trash}>
                End drop
              </Button>
              <Button variant="plain" tone="destructive">
                Leave
              </Button>
              <Button variant="plain" tone="neutral">
                Leave checkout
              </Button>
            </Row>
          </Specimen>
          <Specimen label="Disabled (aria-disabled, still focusable)">
            <Row>
              <Button disabled>Sold out</Button>
              <Button variant="tinted" disabled>
                Watch live
              </Button>
              <Button variant="gray" disabled>
                Edit
              </Button>
              <Button variant="plain" disabled>
                Looks right
              </Button>
            </Row>
          </Specimen>
          <Specimen label="Loading (aria-busy; rest colours and a spinner; the label slot keeps the widest label's width)">
            <Row>
              <Button size="lg" loading reserve={['Buy 2', 'Reserving…']}>
                Reserving…
              </Button>
              <Button variant="gray" loading>
                Publishing…
              </Button>
              <Button variant="plain" icon={LogOut} loading reserve={['Sign out', 'Signing out…']}>
                Signing out…
              </Button>
            </Row>
          </Specimen>
          <Specimen label="Rounded, full width (checkout, dialogs, login)">
            <div className="flex max-w-form flex-col gap-3">
              <Button size="lg" shape="rounded" fullWidth>
                Pay $258.00
              </Button>
              <ButtonLink href="/" size="lg" shape="rounded" variant="gray" fullWidth>
                Back to drops
              </ButtonLink>
            </div>
          </Specimen>
        </div>
      </Section>

      <Section
        title="Icon buttons"
        description="Circular, 32 or 44 px. The accessible name is on the button."
      >
        <Row>
          <IconButton label="Copy order id" icon={Copy} variant="gray" />
          <IconButton label="Copy order id" icon={Copy} variant="gray" size="sm" />
          <IconButton label="Copy order id" icon={Copy} />
          <IconButton label="Copy order id" icon={Copy} size="sm" />
          <IconButton label="Copy order id" icon={Copy} variant="gray" disabled />
          <div className="relative overflow-clip rounded-full">
            <Image src={headphones} alt="" fill sizes="104px" className="object-cover" />
            <div className="material-overlay relative flex gap-1 rounded-full p-1">
              <IconButton label="Play" icon={Play} variant="overlay" />
              <MuteToggle />
            </div>
          </div>
        </Row>
      </Section>

      <Section
        title="Segmented control"
        description="A native radio group: Tab enters it, the arrow keys move."
      >
        <Row>
          <SegmentedDemo />
        </Row>
      </Section>

      <Section
        title="Badges and pills"
        description="Pills are text with an icon, so colour is never the only signal."
      >
        <div className="flex flex-col gap-10">
          <Specimen label="Live badge: md, sm, md pulsing (three cycles, then still), viewer count">
            <Row>
              <LiveBadge />
              <LiveBadge size="sm" />
              <LiveBadge pulse />
              <ViewerCount count={1284} />
              <div className="relative flex h-14 items-center overflow-clip rounded-md px-3">
                <Image src={parfum} alt="" fill sizes="160px" className="object-cover" />
                <span className="relative flex items-center gap-2">
                  <LiveBadge />
                  <ViewerCount count={1} onVideo />
                </span>
              </div>
            </Row>
          </Specimen>
          <Specimen label="Tones">
            <Row>
              <StatusPill tone="neutral" icon={Sparkles}>
                AI
              </StatusPill>
              <StatusPill tone="info" icon={CalendarClock}>
                Scheduled
              </StatusPill>
              <StatusPill tone="success" icon={CircleCheck}>
                Healthy
              </StatusPill>
              <StatusPill tone="warning" icon={TriangleAlert}>
                Degraded
              </StatusPill>
              <StatusPill tone="danger" icon={CircleX}>
                Failing
              </StatusPill>
            </Row>
          </Specimen>
          <Specimen label="Orders">
            <Row>
              {orderStatuses.map((status) => (
                <OrderStatusPill key={status} status={status} />
              ))}
            </Row>
          </Specimen>
          <Specimen label="Drops">
            <Row>
              {dropStatuses.map((status) => (
                <DropStatusPill key={status} status={status} />
              ))}
            </Row>
          </Specimen>
          <Specimen label="Listing jobs">
            <Row>
              {listingStatuses.map((status) => (
                <ListingJobStatusPill key={status} status={status} />
              ))}
            </Row>
          </Specimen>
          <Specimen label="Avatars">
            <Row>
              <Avatar initials="MC" />
              <Avatar initials="AB" size="lg" />
            </Row>
          </Specimen>
        </div>
      </Section>

      <Section title="Price" description="Tabular figures, never coloured. Totals always show cents.">
        <Row>
          <Price cents={12_900} currency="USD" />
          <Price cents={12_950} currency="USD" size="lg" />
          <Price cents={25_800} currency="USD" size="total" />
        </Row>
      </Section>

      <Section
        title="Stock"
        description='"Only" appears only at the urgent threshold. Every state keeps the same height.'
      >
        <div className="grid gap-(--grid-gap) sm:grid-cols-2 md:grid-cols-3">
          {(
            [
              ['Live', stock.live],
              ['Live, urgent', stock.urgent],
              ['All reserved', stock.reserved],
              ['Sold out', stock.soldOut],
              ['Scheduled, under 24 hours', stock.scheduled],
              ['Paused', stock.paused],
              ['Ended', stock.ended],
            ] as const
          ).map(([label, state]) => (
            <Card key={label} label={label}>
              <StockText stock={state} {...drop} />
            </Card>
          ))}
          <Card label="Scheduled, 24 hours or more">
            <StockText stock={stock.scheduled} {...drop} startsAt={at(3 * 24 * hour)} />
          </Card>
          <Card label="Compact, as in the home hero">
            <StockText stock={stock.urgent} {...drop} layout="compact" />
          </Card>
        </div>
        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          <Specimen label="Meter sm">
            <StockMeter {...stock.live} size="sm" />
          </Specimen>
          <Specimen label="Meter md, urgent">
            <StockMeter {...stock.urgent} size="md" urgent />
          </Specimen>
          <Specimen label="Meter lg, admin colours">
            <StockMeter avail={180} held={60} sold={260} size="lg" palette="admin" />
          </Specimen>
        </div>
      </Section>

      <Section
        title="Countdown"
        description="Digits are hidden from screen readers, which read a stable time."
      >
        <div className="grid gap-6 text-body sm:grid-cols-2 md:grid-cols-3">
          <Specimen label="Under an hour">
            <Countdown target={at(4 * minute + 9_000)} serverNow={now} verb="Starts" />
          </Specimen>
          <Specimen label="Under 24 hours">
            <Countdown target={drop.startsAt} serverNow={now} verb="Starts" />
          </Specimen>
          <Specimen label="Closing">
            <Countdown target={drop.endsAt} serverNow={now} verb="Ends" />
          </Specimen>
          <Specimen label="24 hours or more">
            <Countdown target={at(3 * 24 * hour)} serverNow={now} verb="Starts" />
          </Specimen>
          <Specimen label="Passed">
            <Countdown target={at(-minute)} serverNow={now} verb="Starts" />
          </Specimen>
          <Specimen label="Hero">
            <span className="text-callout text-label-secondary">
              <Countdown target={drop.startsAt} serverNow={now} verb="Starts" variant="hero" />
            </span>
          </Specimen>
          <Specimen label="Absolute time, today and later">
            <span>
              <LocalTime iso={at(3 * hour)} /> · <LocalTime iso={at(50 * hour)} />
            </span>
          </Specimen>
        </div>
      </Section>

      <Section
        title="Product tiles"
        description="One tab stop each. The well lifts on hover; the photo never scales."
      >
        <div className="grid gap-x-(--grid-gap) gap-y-12 sm:grid-cols-2 md:grid-cols-3">
          <ProductTile
            href="/p/sage-wireless-headphones"
            title="Sage Wireless Over-Ear Headphones"
            image={headphones}
            priceCents={14_900}
            stock={stock.live}
            {...drop}
          />
          <ProductTile
            href="/p/faceted-eau-de-parfum"
            title="Faceted Glass Eau de Parfum"
            image={parfum}
            priceCents={6_800}
            stock={stock.urgent}
            {...drop}
          />
          <ProductTile
            href="/p/ring-stoneware-vase"
            title="Ring Stoneware Vase"
            image={vase}
            priceCents={4_800}
            stock={stock.scheduled}
            {...drop}
          />
          <ProductTile
            href="/p/linen-band-collar-shirt"
            title="Linen Band-Collar Shirt"
            image={shirt}
            priceCents={7_900}
            stock={stock.soldOut}
            {...drop}
          />
          <ProductTile
            href="/p/amber-jar-candle"
            title="Amber Jar Soy Candle"
            image={candle}
            priceCents={3_400}
            stock={stock.ended}
            {...drop}
          />
          <ProductTileSkeleton />
        </div>
      </Section>

      <Section title="Drop card" description="The purchase unit beside live video and in the home hero.">
        <div className="grid gap-(--grid-gap) rounded-xl bg-canvas p-(--grid-gap) md:grid-cols-2">
          <DropCard
            title="Sage Wireless Over-Ear Headphones"
            image={headphones}
            priceCents={14_900}
            stock={stock.urgent}
            {...drop}
          >
            <PurchaseRow max={drop.perUserLimit} />
          </DropCard>
          <DropCard
            title="Stone and Charcoal Mug Set"
            image={mugs}
            priceCents={4_600}
            stock={stock.reserved}
            {...drop}
          >
            <PurchaseRow max={drop.perUserLimit} disabledLabel="All reserved" />
          </DropCard>
          <DropCard
            title="Ring Stoneware Vase"
            image={vase}
            priceCents={4_800}
            stock={stock.scheduled}
            {...drop}
          >
            <PurchaseRow max={1} disabledLabel="Opens at 7:00 PM" />
          </DropCard>
          <DropCardEmpty />
        </div>
      </Section>

      <Section
        title="Quantity stepper"
        description="44 px, or 56 px beside an lg Buy button. Disabled at 1 and at the limit. Not rendered with a limit of 1."
      >
        <Row>
          <StepperDemo max={2} />
          <StepperDemo max={4} size="lg" />
          <span className="text-footnote text-label-secondary">Limit 2 per person</span>
        </Row>
      </Section>

      <Section
        title="Banners and toasts"
        description="Banners sit at the top of what they are about. Toasts confirm."
      >
        <div className="flex max-w-form flex-col gap-4">
          <Banner tone="info">
            Fields marked AI were generated from your photos. Review every field before publishing.
          </Banner>
          <Banner tone="success" title="All 9 invariants hold.">
            Checked a few seconds ago.
          </Banner>
          <Banner
            tone="warning"
            title="Needs review"
            action={
              <ButtonLink href="/" variant="plain" size="sm" className="-ml-3">
                Review fields
              </ButtonLink>
            }
          >
            Some fields need attention. Fix the highlighted fields to publish.
          </Banner>
          <Banner tone="danger">Couldn't place your order. Check your connection and try again.</Banner>
          <DismissibleBanner />
        </div>
        <div className="mt-8">
          <ToastDemo />
        </div>
      </Section>

      <Section
        title="Dialogs and sheets"
        description="Native dialog: focus trap, inert page, Esc, focus returns to the opener."
      >
        <Row>
          <DialogDemo />
          <SheetDemo />
        </Row>
      </Section>

      <Section
        title="Empty states and skeletons"
        description="Calm copy with the next step. Skeletons never shimmer."
      >
        <div className="grid items-start gap-(--grid-gap) md:grid-cols-2">
          <div className="rounded-lg bg-bg-secondary">
            <EmptyState
              icon={Layers}
              title="No live drops"
              description="Drops show up here while they're live."
              action={
                <ButtonLink href="/" variant="tinted">
                  Show all
                </ButtonLink>
              }
            />
          </div>
          <div className="flex flex-col gap-3 rounded-lg bg-surface p-6 elevation-1">
            <SkeletonText style="title-3" className="w-1/2" />
            <SkeletonText style="body" />
            <SkeletonText style="body" className="w-4/5" />
            <SkeletonText style="footnote" className="w-24" />
          </div>
        </div>
      </Section>

      <Section title="Navigation bar" description="Translucent over content. Everything on it is label.">
        <div className="flex flex-col gap-6">
          {(
            [
              ['Signed out', null, null],
              [
                'Signed in, a drop is live',
                { name: 'Ada Buyer', initials: 'AB', adminHref: null },
                '/live/spring',
              ],
              ['Admin', { name: 'Mira Chen', initials: 'MC', adminHref: '/admin/drops' }, '/live/spring'],
            ] as const
          ).map(([label, account, liveHref]) => (
            <Specimen key={label} label={label}>
              {/* Inert: a specimen of the bar, not a second navigation for the page. */}
              <div inert className="relative w-full overflow-clip rounded-lg">
                <Image src={candle} alt="" fill sizes="1200px" className="object-cover" />
                <div className="relative pb-16">
                  <NavigationBar account={account} liveHref={liveHref} sticky={false} />
                </div>
              </div>
            </Specimen>
          ))}
        </div>
      </Section>
    </>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const id = `section-${title.toLowerCase().replaceAll(' ', '-')}`;
  return (
    <section aria-labelledby={id} className="mt-16 border-separator border-t pt-12">
      <h2 id={id} className="text-title-2">
        {title}
      </h2>
      <p className="mt-2 max-w-text text-callout text-label-secondary">{description}</p>
      <div className="mt-8">{children}</div>
    </section>
  );
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-caption text-label-secondary">{label}</p>
      {children}
    </div>
  );
}

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-bg-secondary p-5">
      <p className="mb-4 text-caption text-label-secondary">{label}</p>
      {children}
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

type Swatch = { name: string; className: string };

function SwatchGroup({ title, swatches }: { title: string; swatches: readonly Swatch[] }) {
  return (
    <div className="mb-8">
      <h3 className="text-headline">{title}</h3>
      <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {swatches.map(({ name, className }) => (
          <li key={name} className="flex flex-col gap-2">
            <span className={cx('h-14 rounded-md border border-separator', className)} />
            <span className="text-caption text-label-secondary">{name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const surfaceSwatches: readonly Swatch[] = [
  { name: 'bg', className: 'bg-bg' },
  { name: 'bg-secondary', className: 'bg-bg-secondary' },
  { name: 'canvas', className: 'bg-canvas' },
  { name: 'surface', className: 'bg-surface' },
  { name: 'surface-raised', className: 'bg-surface-raised' },
  { name: 'thumb', className: 'bg-thumb' },
];

const fillSwatches: readonly Swatch[] = [
  { name: 'fill', className: 'bg-fill' },
  { name: 'fill-secondary', className: 'bg-fill-secondary' },
  { name: 'fill-tertiary', className: 'bg-fill-tertiary' },
  { name: 'fill-quaternary', className: 'bg-fill-quaternary' },
  { name: 'scrim', className: 'bg-scrim' },
];

const labelSwatches: readonly Swatch[] = [
  { name: 'label', className: 'bg-label' },
  { name: 'label-secondary', className: 'bg-label-secondary' },
  { name: 'label-tertiary', className: 'bg-label-tertiary' },
  { name: 'separator', className: 'bg-separator' },
  { name: 'control', className: 'bg-control' },
  { name: 'focus', className: 'bg-focus' },
];

const accentSwatches: readonly Swatch[] = [
  { name: 'accent', className: 'bg-accent' },
  { name: 'accent-label', className: 'bg-accent-label' },
  { name: 'accent-tint', className: 'bg-accent-tint' },
  { name: 'live', className: 'bg-live' },
  { name: 'success', className: 'bg-success' },
  { name: 'success-tint', className: 'bg-success-tint' },
  { name: 'warning', className: 'bg-warning' },
  { name: 'warning-tint', className: 'bg-warning-tint' },
  { name: 'danger', className: 'bg-danger' },
  { name: 'danger-tint', className: 'bg-danger-tint' },
];

const chartSwatches: readonly Swatch[] = [
  { name: 'chart-1', className: 'bg-chart-1' },
  { name: 'chart-2', className: 'bg-chart-2' },
  { name: 'chart-3', className: 'bg-chart-3' },
  { name: 'chart-4', className: 'bg-chart-4' },
  { name: 'chart-grid', className: 'bg-chart-grid' },
  { name: 'chart-muted', className: 'bg-chart-muted' },
];

const typeStyles = [
  { name: 'Display 1', className: 'text-display-1', sample: 'Aurora Runner 2' },
  { name: 'Display 2', className: 'text-display-2', sample: 'You got it.' },
  { name: 'Title 1', className: 'text-title-1', sample: 'Upcoming drops' },
  { name: 'Title 2', className: 'text-title-2', sample: 'Reserved for you' },
  { name: 'Title 3', className: 'text-title-3', sample: 'Sage Wireless Over-Ear Headphones' },
  { name: 'Headline', className: 'text-headline', sample: 'Only 12 left' },
  {
    name: 'Intro',
    className: 'text-intro',
    sample: 'Featherlight knit, a carbon plate and exactly 500 pairs.',
  },
  { name: 'Body', className: 'text-body', sample: 'We hold your item for 2 minutes at checkout.' },
  { name: 'Callout', className: 'text-callout', sample: 'Couldn’t place your order. Try again.' },
  { name: 'Footnote', className: 'text-footnote', sample: '488 of 500 claimed' },
  { name: 'Caption', className: 'text-caption', sample: 'Ready for review' },
] as const;

const orderStatuses = [
  'RESERVED',
  'PENDING_PAYMENT',
  'PAID',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
  'REJECTED',
] as const;
const dropStatuses = ['DRAFT', 'SCHEDULED', 'LIVE', 'PAUSED', 'ENDED', 'RECONCILING'] as const;
const listingStatuses = ['PENDING', 'RUNNING', 'READY', 'NEEDS_REVIEW', 'FAILED', 'APPROVED'] as const;
