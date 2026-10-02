import { PROBLEM_CONTENT_TYPE, ProblemDetails } from '@flashdrop/contracts';
import type { z } from 'zod';
import { apiEnv } from './env';

/** A Server Component never waits on api longer than this; the route's error state takes over instead. */
const TIMEOUT_MS = 5_000;

/** api answered with an error status. `problem` is its RFC 9457 body when it sent a valid one. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly path: string;
  readonly status: number;
  readonly problem: ProblemDetails | undefined;

  constructor(path: string, status: number, problem: ProblemDetails | undefined) {
    super(`GET ${path} answered ${status}${problem ? ` ${problem.code}` : ''}`);
    this.path = path;
    this.status = status;
    this.problem = problem;
  }
}

async function readProblem(response: Response): Promise<ProblemDetails | undefined> {
  if (!response.headers.get('content-type')?.startsWith(PROBLEM_CONTENT_TYPE)) return undefined;
  const parsed = ProblemDetails.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? parsed.data : undefined;
}

type GetOptions = {
  /** The browser's `Cookie` header, for reads that depend on the session. */
  cookie?: string;
};

/**
 * GETs `path` from api over `API_INTERNAL_URL` and validates the body against the shared contract, so a
 * drifted response fails here, loudly, instead of rendering half a page. Server-only: the browser calls
 * the same paths same-origin.
 */
export async function apiGet<S extends z.ZodType>(
  path: `/api/v1/${string}`,
  schema: S,
  { cookie }: GetOptions = {},
): Promise<z.output<S>> {
  const response = await fetch(new URL(path, apiEnv().API_INTERNAL_URL), {
    headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new ApiError(path, response.status, await readProblem(response));
  return schema.parse(await response.json());
}
