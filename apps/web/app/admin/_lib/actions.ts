'use server';

import {
  AdminDropAction,
  AdminDropResponse,
  ApproveListingBody,
  ApproveListingResponse,
  CreateDropBody,
  type DropStatus,
  PatchDropBody,
  Uuid,
} from '@flashdrop/contracts';
import { refresh, updateTag } from 'next/cache';
import type { z } from 'zod';
import { type ActionFailure, failureOf } from '../../../components/admin/problem-copy';
import { adminWrite } from './api';

/*
 * The admin area's Server Actions (SD §8.1): each validates its input with the shared contract (an action is
 * a public endpoint), forwards it to api as the signed-in admin, and on success revalidates the storefront
 * caches the change touches, so the next storefront render reads the write (`updateTag` is Server-Action
 * only, which is why these writes go through web rather than straight from the browser).
 */

export type ActionResult<T> = { ok: true; value: T } | { ok: false; failure: ActionFailure };

function invalid(error: z.ZodError): { ok: false; failure: ActionFailure } {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    fields[path] ??= issue.message;
  }
  return {
    ok: false,
    failure: { code: 'VALIDATION_FAILED', message: 'Some fields need attention.', fields },
  };
}

/** The storefront caches drop lists under `drops` and each product page under `product:<id>` (SD §8.1). */
function revalidateStorefront(productId: string): void {
  updateTag('drops');
  updateTag(`product:${productId}`);
}

/** Arm, pause, resume, end or reconcile a drop (SD §5.1). Every one takes the drop lock in api. */
export async function runDropAction(
  dropId: string,
  action: AdminDropAction,
): Promise<ActionResult<{ status: DropStatus }>> {
  const id = Uuid.safeParse(dropId);
  if (!id.success) return invalid(id.error);
  const verb = AdminDropAction.safeParse(action);
  if (!verb.success) return invalid(verb.error);
  const result = await adminWrite(
    'POST',
    `/api/v1/admin/drops/${id.data}/${verb.data}`,
    undefined,
    AdminDropResponse,
  );
  if (!result.ok) return { ok: false, failure: failureOf(result.status, result.problem) };
  revalidateStorefront(result.value.drop.productId);
  refresh();
  return { ok: true, value: { status: result.value.drop.status } };
}

/** A DRAFT drop for a product, priced by the admin (SD §3). Drafts are invisible to buyers. */
export async function createDrop(input: unknown): Promise<ActionResult<{ id: string }>> {
  const body = CreateDropBody.safeParse(input);
  if (!body.success) return invalid(body.error);
  const result = await adminWrite('POST', '/api/v1/admin/drops', body.data, AdminDropResponse);
  if (!result.ok) return { ok: false, failure: failureOf(result.status, result.problem) };
  refresh();
  return { ok: true, value: { id: result.value.drop.id } };
}

/** Changes a DRAFT drop; an armed one answers 409 `DROP_ARMED` (SD §4.7). */
export async function editDrop(dropId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const id = Uuid.safeParse(dropId);
  if (!id.success) return invalid(id.error);
  const body = PatchDropBody.safeParse(input);
  if (!body.success) return invalid(body.error);
  const result = await adminWrite('PATCH', `/api/v1/admin/drops/${id.data}`, body.data, AdminDropResponse);
  if (!result.ok) return { ok: false, failure: failureOf(result.status, result.problem) };
  refresh();
  return { ok: true, value: { id: result.value.drop.id } };
}

/**
 * Publishes a reviewed listing (SD §10): api re-validates it with `ListingDraft` and creates the PUBLISHED
 * product. `updateTag` then drops any cached render of the product, so its page shows it at once.
 */
export async function approveListing(
  jobId: string,
  input: unknown,
): Promise<ActionResult<{ productId: string; slug: string }>> {
  const id = Uuid.safeParse(jobId);
  if (!id.success) return invalid(id.error);
  const body = ApproveListingBody.safeParse(input);
  if (!body.success) return invalid(body.error);
  const result = await adminWrite(
    'POST',
    `/api/v1/admin/listings/${id.data}/approve`,
    body.data,
    ApproveListingResponse,
  );
  if (!result.ok) return { ok: false, failure: failureOf(result.status, result.problem) };
  const { product } = result.value;
  updateTag(`product:${product.id}`);
  return { ok: true, value: { productId: product.id, slug: product.slug } };
}
