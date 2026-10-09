import { randomUUID } from 'node:crypto';
import type { ListingJob } from '@flashdrop/contracts';
import { DomainError, NotFoundError } from '@flashdrop/domain';
import type { ListingService, NewListingUpload } from '../services/admin-listings';

export type MultipartPart =
  | { readonly field: string; readonly file: Buffer; readonly filename?: string; readonly type?: string }
  | { readonly field: string; readonly value: string };

/** A `multipart/form-data` body as a browser sends it, for `inject()`. */
export function multipartBody(parts: readonly MultipartPart[]): { body: Buffer; contentType: string } {
  const boundary = `----flashdrop${randomUUID().replaceAll('-', '')}`;
  const chunks = parts.flatMap((part) => {
    const head =
      'file' in part
        ? `--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"; filename="${part.filename ?? 'photo.jpg'}"\r\nContent-Type: ${part.type ?? 'image/jpeg'}\r\n\r\n`
        : `--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"\r\n\r\n`;
    return [Buffer.from(head), 'file' in part ? part.file : Buffer.from(part.value), Buffer.from('\r\n')];
  });
  return {
    body: Buffer.concat([...chunks, Buffer.from(`--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** An in-memory `ListingService` for `inject()` tests: the routes run for real, without Postgres. */
export interface FakeListings extends ListingService {
  readonly submitted: NewListingUpload[];
  readonly jobs: Map<string, ListingJob>;
}

export function createFakeListings(): FakeListings {
  const submitted: NewListingUpload[] = [];
  const jobs = new Map<string, ListingJob>();
  const get = async (jobId: string) => {
    const job = jobs.get(jobId);
    if (job === undefined) throw new NotFoundError('Listing job');
    return job;
  };
  return {
    submitted,
    jobs,
    async submit(job) {
      submitted.push(job);
      const id = randomUUID();
      jobs.set(id, {
        id,
        status: 'PENDING',
        imageKeys: [...job.imageKeys],
        hints: job.hints,
        createdAt: new Date(0).toISOString(),
        provider: null,
        model: null,
        promptVersion: 'test',
        attempts: 0,
        draft: null,
        final: null,
        issues: [],
        failure: null,
        calls: [],
        costUsd: null,
        latencyMs: null,
        productId: null,
        productSlug: null,
        editRate: null,
      });
      return { jobId: id, status: 'PENDING', reused: false };
    },
    async list(limit) {
      return [...jobs.values()].slice(0, limit).map((job) => ({
        id: job.id,
        status: job.status,
        imageKey: job.imageKeys[0] ?? '',
        title: job.draft?.title ?? null,
        createdAt: job.createdAt,
        productSlug: job.productSlug,
      }));
    },
    get,
    async approve(jobId, { listing, slug }) {
      const job = await get(jobId);
      if (job.status !== 'READY' && job.status !== 'NEEDS_REVIEW') throw new DomainError('CONFLICT');
      const product = { id: randomUUID(), slug: slug ?? 'approved-product' };
      const approved: ListingJob = {
        ...job,
        status: 'APPROVED',
        final: listing,
        productId: product.id,
        productSlug: product.slug,
      };
      jobs.set(jobId, approved);
      return { job: approved, product };
    },
  };
}
