import { DROP_STATUSES } from '@flashdrop/domain';
import { z } from 'zod';
import { AdminDrop } from './admin';
import { ProductSummary } from './catalog';
import { Slug, Uuid } from './common';

/*
 * The reads behind the admin drop pages (design §5.1, design system §10.8): every drop of the catalog in any
 * status, DRAFT included, and the products and rooms the "New drop" sheet offers. Admin only, never cached.
 * Test products (`POST /test/drops`) are left out, as from the storefront: specs and load runs create
 * hundreds of them, and the health page links the tracked ones.
 */

/** A live room a drop can sell in. */
export const AdminRoom = z.object({ id: Uuid, slug: Slug, title: z.string().min(1) });
export type AdminRoom = z.infer<typeof AdminRoom>;

/** A drop with its stock of record, its product and its room, as the admin list and detail show it. */
export const AdminDropListing = AdminDrop.extend({
  product: ProductSummary,
  room: AdminRoom.nullable(),
});
export type AdminDropListing = z.infer<typeof AdminDropListing>;

/**
 * `GET /api/v1/admin/drops?status=draft,live&limit=`: `status` is a comma-separated list of drop statuses in
 * any case (every status when absent).
 */
export const AdminDropListQuery = z.object({
  status: z
    .string()
    .transform((value) => value.split(',').map((status) => status.trim().toUpperCase()))
    .pipe(z.array(z.enum(DROP_STATUSES)).min(1))
    .transform((statuses) => [...new Set(statuses)])
    .default([...DROP_STATUSES]),
  limit: z.coerce.number().pipe(z.int().min(1).max(200)).default(100),
});
export type AdminDropListQuery = z.output<typeof AdminDropListQuery>;

/**
 * LIVE and PAUSED drops first, then SCHEDULED and DRAFT ones by start time (earliest first), then ENDED ones,
 * most recently ended first: what is selling, then what is next, then history.
 */
export const AdminDropListResponse = z.object({ drops: z.array(AdminDropListing) });
export type AdminDropListResponse = z.infer<typeof AdminDropListResponse>;

/** `GET /api/v1/admin/drops/:id`. */
export const AdminDropDetailResponse = z.object({ drop: AdminDropListing });
export type AdminDropDetailResponse = z.infer<typeof AdminDropDetailResponse>;

/** A PUBLISHED product a drop can be created for. */
export const AdminProductOption = ProductSummary.extend({
  /**
   * The product's SCHEDULED, LIVE or PAUSED drop, if any. A draft can still be created, but arming it fails
   * while this one is open (`one_open_drop_per_product`, §3).
   */
  openDropId: Uuid.nullable(),
});
export type AdminProductOption = z.infer<typeof AdminProductOption>;

/** `GET /api/v1/admin/products`: newest first. */
export const AdminProductListResponse = z.object({ products: z.array(AdminProductOption) });
export type AdminProductListResponse = z.infer<typeof AdminProductListResponse>;

/** `GET /api/v1/admin/rooms`, by title. */
export const AdminRoomListResponse = z.object({ rooms: z.array(AdminRoom) });
export type AdminRoomListResponse = z.infer<typeof AdminRoomListResponse>;
