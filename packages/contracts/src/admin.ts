import {
  DROP_STATUSES,
  HOLD_SECONDS_RANGE,
  PAYMENT_SECONDS_RANGE,
  PER_USER_LIMIT_RANGE,
} from '@flashdrop/domain';
import { z } from 'zod';
import { Cents, Currency, IsoDateTime, Uuid } from './common';

/*
 * Drop administration (design §4.7, §5.1). A drop is edited only while DRAFT; `arm` moves it to SCHEDULED
 * and builds its Redis state, after which it is immutable apart from its status (pause, resume, end).
 * Every action takes the per-drop lock; a busy drop answers 409 `DROP_BUSY`, an armed one 409 `DROP_ARMED`.
 */

export const DropStatus = z.enum(DROP_STATUSES);
export type DropStatus = z.infer<typeof DropStatus>;

export const PerUserLimit = z.int().min(PER_USER_LIMIT_RANGE.min).max(PER_USER_LIMIT_RANGE.max);
export const HoldSeconds = z.int().min(HOLD_SECONDS_RANGE.min).max(HOLD_SECONDS_RANGE.max);
export const PaymentSeconds = z.int().min(PAYMENT_SECONDS_RANGE.min).max(PAYMENT_SECONDS_RANGE.max);
/** Units of a drop (`drop_inventory.total`). */
export const DropStock = z.int().min(1).max(100_000);

const windowIsOrdered = (window: { startsAt?: string; endsAt?: string }) =>
  window.startsAt === undefined ||
  window.endsAt === undefined ||
  Date.parse(window.endsAt) > Date.parse(window.startsAt);
const WINDOW_ISSUE = { message: 'endsAt must be after startsAt', path: ['endsAt'] };

/** `POST /api/v1/admin/drops`: a DRAFT drop with its inventory. The price is typed by an admin (§3). */
export const CreateDropBody = z
  .object({
    productId: Uuid,
    roomId: Uuid.nullable().default(null),
    startsAt: IsoDateTime,
    endsAt: IsoDateTime,
    priceCents: Cents,
    currency: Currency.default('USD'),
    perUserLimit: PerUserLimit.default(2),
    holdSeconds: HoldSeconds.default(120),
    paymentSeconds: PaymentSeconds.default(300),
    stock: DropStock,
  })
  .refine(windowIsOrdered, WINDOW_ISSUE);
export type CreateDropBody = z.output<typeof CreateDropBody>;

/**
 * `PATCH /api/v1/admin/drops/:id`, DRAFT only. A window bound sent alone is checked against the stored one
 * by the database (`drops_window`).
 */
export const PatchDropBody = z
  .object({
    productId: Uuid,
    roomId: Uuid.nullable(),
    startsAt: IsoDateTime,
    endsAt: IsoDateTime,
    priceCents: Cents,
    currency: Currency,
    perUserLimit: PerUserLimit,
    holdSeconds: HoldSeconds,
    paymentSeconds: PaymentSeconds,
    stock: DropStock,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'nothing to change' })
  .refine(windowIsOrdered, WINDOW_ISSUE);
export type PatchDropBody = z.output<typeof PatchDropBody>;

/** A drop with its stock of record, as the admin UI shows it. */
export const AdminDrop = z.object({
  id: Uuid,
  productId: Uuid,
  roomId: Uuid.nullable(),
  status: DropStatus,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  priceCents: Cents,
  currency: Currency,
  perUserLimit: PerUserLimit,
  holdSeconds: HoldSeconds,
  paymentSeconds: PaymentSeconds,
  inventory: z.object({
    total: DropStock,
    reserved: z.int().nonnegative(),
    sold: z.int().nonnegative(),
    /** The generation of the drop's Redis state (§4.7); bumped by every rebuild. */
    redisGen: z.int().nonnegative(),
  }),
});
export type AdminDrop = z.infer<typeof AdminDrop>;

export const AdminDropResponse = z.object({ drop: AdminDrop });
export type AdminDropResponse = z.infer<typeof AdminDropResponse>;

export const AdminDropParams = z.object({ id: Uuid });
export type AdminDropParams = z.infer<typeof AdminDropParams>;

/** `POST /api/v1/admin/drops/:id/<action>`. `arm` and `reconcile` run the full Redis sync (§4.7). */
export const ADMIN_DROP_ACTIONS = ['arm', 'pause', 'resume', 'end', 'reconcile'] as const;
export const AdminDropAction = z.enum(ADMIN_DROP_ACTIONS);
export type AdminDropAction = z.infer<typeof AdminDropAction>;
