import fastifyMultipart from '@fastify/multipart';
import {
  ApproveListingBody,
  ApproveListingResponse,
  CreateListingResponse,
  ListingJob,
  ListingJobListQuery,
  ListingJobListResponse,
  ListingJobParams,
} from '@flashdrop/contracts';
import type { Api } from '../../http/api';
import { rateLimitHook } from '../../http/rate-limit';
import { adminOnly, requireAdmin } from '../../http/session';
import type { ListingService } from './listings-store';
import { LISTING_MULTIPART_OPTIONS, readListingUpload } from './listings-upload';

/** Uploads per admin per minute: each one can cost up to three model calls (design §11). */
export const LISTING_UPLOADS_PER_MINUTE = 10;

export interface ListingRouteDeps {
  readonly listings: ListingService;
  /** `UPLOAD_DIR`, shared with the worker's `listing` role. */
  readonly uploadDir: string;
}

/**
 * The listing generator's admin API (design §10), admins only:
 *
 *   POST /admin/listings                multipart photos and hints -> 202 {jobId, status}
 *   GET  /admin/listings                the latest jobs
 *   GET  /admin/listings/:jobId         the job, its draft, issues and per-call usage
 *   POST /admin/listings/:jobId/approve the reviewed listing -> a PUBLISHED product
 */
export function listingRoutes(app: Api, { listings, uploadDir }: ListingRouteDeps): void {
  const uploadLimit = rateLimitHook(app, {
    route: 'listing-upload',
    max: LISTING_UPLOADS_PER_MINUTE,
    windowMs: 60_000,
    subject: (request) => request.session?.sub ?? 'anonymous',
  });

  // The multipart parser exists only in this scope: every other route stays JSON-only (§11).
  void app.register(async (scope: Api) => {
    await scope.register(fastifyMultipart, LISTING_MULTIPART_OPTIONS);
    scope.post(
      '/admin/listings',
      // The admin check first, so the limit counts admins only, and both before a byte of the body is read.
      { onRequest: [adminOnly, uploadLimit], schema: { response: { 202: CreateListingResponse } } },
      async (request, reply) => {
        const admin = requireAdmin(request);
        const upload = await readListingUpload(request, uploadDir);
        const { jobId, status, reused } = await listings.submit({ createdBy: admin.sub, ...upload });
        request.log.info({ jobId, reused, photos: upload.imageKeys.length }, 'listing upload accepted');
        reply.code(202);
        return { jobId, status };
      },
    );
  });

  app.get(
    '/admin/listings',
    {
      onRequest: adminOnly,
      schema: { querystring: ListingJobListQuery, response: { 200: ListingJobListResponse } },
    },
    async (request) => ({ jobs: await listings.list(request.query.limit) }),
  );

  app.get(
    '/admin/listings/:jobId',
    { onRequest: adminOnly, schema: { params: ListingJobParams, response: { 200: ListingJob } } },
    async (request) => listings.get(request.params.jobId),
  );

  app.post(
    '/admin/listings/:jobId/approve',
    {
      onRequest: adminOnly,
      schema: {
        params: ListingJobParams,
        body: ApproveListingBody,
        response: { 200: ApproveListingResponse },
      },
    },
    async (request) => listings.approve(request.params.jobId, request.body),
  );
}
