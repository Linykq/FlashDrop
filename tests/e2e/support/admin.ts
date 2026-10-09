import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AdminDashboardResponse,
  CreateListingResponse,
  DevUsersResponse,
  type ListingJob,
  ListingJob as ListingJobSchema,
} from '@flashdrop/contracts';
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type FileChooser,
  type Page,
} from '@playwright/test';

/*
 * The admin's side of the specs (design §9, §10, §11): a context signed in as the seeded admin through the dev
 * login, as a person would on `/login`, and the admin reads and uploads the dashboard and listing specs need.
 * The admin account is shared by every spec; what a spec asserts is always its own drop or listing job.
 */

/** The listing generator's fixture photos (`tests/fixtures/images`, see its README for each outcome). */
export const LISTING_PHOTOS = join(import.meta.dirname, '..', '..', 'fixtures', 'images');

/** How long the listing service may take with the fixture provider: a claim tick plus up to 3 calls. */
export const LISTING_SETTLES_WITHIN_MS = 20_000;

/** Signs `context` in as the first seeded admin; its pages and `context.request` share the session. */
export async function signInAdmin(context: BrowserContext, baseURL: string | undefined): Promise<void> {
  if (baseURL === undefined) throw new Error('playwright.config.ts sets no baseURL');
  const users = await context.request.get('/api/v1/auth/dev-users');
  expect(users.status(), 'GET /auth/dev-users').toBe(200);
  const admin = DevUsersResponse.parse(await users.json()).users.find((user) => user.role === 'admin');
  if (admin === undefined) throw new Error('No seeded admin: run `pnpm db:seed`');
  const login = await context.request.post('/api/v1/auth/dev-login', {
    data: { userId: admin.id },
    headers: { origin: new URL(baseURL).origin },
  });
  expect(login.status(), `dev login as ${admin.email}`).toBe(204);
}

/** `GET /admin/dashboard/drops/:dropId` with an admin's session. */
export async function dashboardOf(
  request: APIRequestContext,
  dropId: string,
): Promise<AdminDashboardResponse> {
  const response = await request.get(`/api/v1/admin/dashboard/drops/${dropId}`);
  expect(response.status(), `GET dashboard of ${dropId}`).toBe(200);
  return AdminDashboardResponse.parse(await response.json());
}

/** `GET /admin/listings/:jobId` with an admin's session. */
export async function listingJobOf(request: APIRequestContext, jobId: string): Promise<ListingJob> {
  const response = await request.get(`/api/v1/admin/listings/${jobId}`);
  expect(response.status(), `GET listing job ${jobId}`).toBe(200);
  return ListingJobSchema.parse(await response.json());
}

/**
 * Fails, with the fix, when the stack's listing service answers from Anthropic instead of the recorded
 * fixtures: the specs assert which answer each photo gets and how many calls it takes, so on a live model
 * they fail anyway, and every run would cost money. compose.yaml defaults to the fixtures; only an explicit
 * `LLM_PROVIDER=anthropic` (the shell or `.env`) switches it.
 */
export function expectFixtureProvider(job: ListingJob): void {
  expect(
    job.provider,
    `listing job ${job.id} ran on '${job.provider}': the listing specs need the fixture provider. Restart ` +
      'the stack without LLM_PROVIDER=anthropic in the shell or .env (pnpm stack:up).',
  ).toBe('fixture');
}

/** Waits until the listing role has finished `jobId` (any status but PENDING and RUNNING), on the fixtures. */
export async function settledListingJob(request: APIRequestContext, jobId: string): Promise<ListingJob> {
  await expect
    .poll(async () => (await listingJobOf(request, jobId)).status, {
      message: `listing job ${jobId} settles (is the listing service running?)`,
      timeout: LISTING_SETTLES_WITHIN_MS,
    })
    .not.toMatch(/^(PENDING|RUNNING)$/);
  const job = await listingJobOf(request, jobId);
  expectFixtureProvider(job);
  return job;
}

/**
 * Uploads one fixture photo as a new listing job through the api, as the upload form does. Identical uploads
 * share a job (§10), so `hints` must be unique to the caller: it is part of the job's input hash.
 */
export async function uploadListing(
  request: APIRequestContext,
  baseURL: string | undefined,
  photo: string,
  hints: string,
): Promise<string> {
  if (baseURL === undefined) throw new Error('playwright.config.ts sets no baseURL');
  const response = await request.post('/api/v1/admin/listings', {
    headers: { origin: new URL(baseURL).origin },
    multipart: {
      images: { name: photo, mimeType: 'image/jpeg', buffer: await readFile(join(LISTING_PHOTOS, photo)) },
      hints,
    },
  });
  expect(response.status(), `upload ${photo}: ${await response.text()}`).toBe(202);
  return CreateListingResponse.parse(await response.json()).jobId;
}

/**
 * Chooses `files` on the new listing page through "Choose photos", as a person would. Until the form has
 * hydrated the button opens nothing, so it is pressed again until the file chooser opens.
 */
export async function choosePhotos(page: Page, files: Parameters<FileChooser['setFiles']>[0]): Promise<void> {
  const button = page.getByRole('button', { name: 'Choose photos' });
  let chooser: FileChooser | undefined;
  await expect(async () => {
    const opened = page.waitForEvent('filechooser', { timeout: 1_000 });
    await button.click();
    chooser = await opened;
  }).toPass({ timeout: 15_000 });
  if (chooser === undefined) throw new Error('the file chooser never opened');
  await chooser.setFiles(files);
}
