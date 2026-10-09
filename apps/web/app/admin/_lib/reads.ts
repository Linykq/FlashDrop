import {
  AdminDashboardResponse,
  AdminDropDetailResponse,
  type AdminDropListing,
  ListingJob,
  Uuid,
} from '@flashdrop/contracts';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { adminRead } from './api';

/*
 * Admin reads that a page and its metadata share, memoised per request so the title costs no second api
 * call. A malformed id never reaches api.
 */

function validId(id: string): string {
  if (!Uuid.safeParse(id).success) notFound();
  return id;
}

export const readAdminDrop = cache(async (dropId: string): Promise<AdminDropListing> => {
  const id = validId(dropId);
  const { drop } = await adminRead(
    `/api/v1/admin/drops/${id}`,
    AdminDropDetailResponse,
    `/admin/drops/${id}`,
  );
  return drop;
});

export const readDashboard = cache(async (dropId: string): Promise<AdminDashboardResponse> => {
  const id = validId(dropId);
  return adminRead(`/api/v1/admin/dashboard/drops/${id}`, AdminDashboardResponse, `/admin/dashboard/${id}`);
});

export const readListingJob = cache(async (jobId: string): Promise<ListingJob> => {
  const id = validId(jobId);
  return adminRead(`/api/v1/admin/listings/${id}`, ListingJob, `/admin/listings/${id}`);
});
