import type { ListingEffort } from '@flashdrop/config';
import { createListingModel, LISTING_PROMPT_VERSION, type ListingModelSettings } from '@flashdrop/llm';
import type { WorkerDeps } from '../deps';
import type { ComponentHealth } from '../health';
import { createLoop } from '../loop';
import { claimListingJob } from './jobs';
import { type ListingRunDeps, runListingJob } from './run';

/*
 * The `listing` role (design §10). A loop claims due jobs into a few slots and runs each in the background,
 * so the loop's own ticks stay short and its health reflects the queue, not a call that may take minutes.
 * Any number of workers can run the role: claims use `SKIP LOCKED`, and every write is fenced by the lease.
 *
 * On shutdown the loop stops claiming, the calls in flight are aborted, and their jobs go straight back to
 * PENDING for the next worker; the calls they already made stay billed and counted.
 */

/** `LlmEnv` plus where this process finds the fixtures (its entry resolves the path, see main.ts). */
export interface ListingRoleSettings extends ListingModelSettings {
  readonly LISTING_EFFORT: ListingEffort;
  readonly UPLOAD_DIR: string;
  readonly fixturesDir: string;
}

/** Jobs one worker runs at once, so one slow three-call job never holds up the next upload. */
export const LISTING_SLOTS = 2;

/** How often an idle worker looks for jobs; a finished job also looks at once. */
const POLL_MS = 1_000;

export interface ListingWorker {
  health(): readonly ComponentHealth[];
  stop(): Promise<void>;
}

export function startListingWorker(
  deps: ListingRunDeps,
  options: { readonly slots?: number; readonly everyMs?: number } = {},
): ListingWorker {
  const slots = options.slots ?? LISTING_SLOTS;
  const runner = {
    provider: deps.model.provider,
    model: deps.model.model,
    promptVersion: LISTING_PROMPT_VERSION,
  };
  const abort = new AbortController();
  const running = new Set<Promise<void>>();

  const loop = createLoop(
    {
      name: 'listing-jobs',
      everyMs: options.everyMs ?? POLL_MS,
      tick: async (signal) => {
        while (running.size < slots && !signal.aborted) {
          const job = await claimListingJob(deps.db, runner);
          if (job === null) return;
          const run: Promise<void> = runListingJob(deps, job, abort.signal)
            .then(
              () => undefined,
              // The job keeps its lease and is resumed once it expires.
              (err: unknown) => deps.logger.error({ err, jobId: job.id }, 'listing run failed'),
            )
            .finally(() => {
              running.delete(run);
              loop.wake();
            });
          running.add(run);
        }
      },
    },
    deps.logger,
  );
  loop.start();

  return {
    health: () => [loop.health()],
    async stop() {
      await loop.stop();
      abort.abort();
      await Promise.all(running);
    },
  };
}

export async function startListingRole(
  deps: WorkerDeps,
  settings: ListingRoleSettings,
): Promise<ListingWorker> {
  const logger = deps.logger.child({ role: 'listing' });
  const model = await createListingModel(settings, { fixturesDir: settings.fixturesDir, logger });
  return startListingWorker({
    db: deps.db,
    redis: deps.redis,
    logger,
    model,
    effort: settings.LISTING_EFFORT,
    uploadDir: settings.UPLOAD_DIR,
  });
}
