import { performance } from 'node:perf_hooks';
import type { ListingEffort } from '@flashdrop/config';
import type {
  ListingCall,
  ListingDraft,
  ListingFailure,
  ListingIssue,
  ListingWire,
} from '@flashdrop/contracts';
import { BugError } from '@flashdrop/domain';
import { type AttemptResult, classifyResponse } from './attempt';
import type { ListingImage, ListingModel, ListingTurn } from './model';
import { callCostUsd } from './models';
import { repairInstruction } from './prompt';
import type { ModelResponse } from './response';

/*
 * The attempt-and-repair loop (design §10), at most three model calls per job:
 *
 * - refusal   -> FAILED with the refusal category. A product photo should never trip a classifier, so a
 *                refusal is reported, not retried (the request already carries the server-side fallback).
 * - truncated -> one retry at effort `low` when a higher effort was configured, else NEEDS_REVIEW. Never a
 *                bigger `max_tokens`: 32k on a non-streaming request risks the HTTP timeout.
 * - invalid   -> a repair turn: the answer replayed unchanged plus the path-level issues.
 * - ok        -> READY.
 * - out of calls -> NEEDS_REVIEW with the last issues and the last answer that had the right shape.
 *
 * One addition: when the only issues left are required attributes the model itself listed as uncertain,
 * the job goes to NEEDS_REVIEW at once. A repair turn could only fix them by guessing (the system prompt
 * forbids exactly that) and would spend up to two more calls finding out.
 */

export const MAX_LISTING_CALLS = 3;

export interface GenerateOptions {
  readonly model: ListingModel;
  readonly images: readonly ListingImage[];
  readonly hints: string | null;
  /** `LISTING_EFFORT`; ignored by a model without effort. */
  readonly effort: ListingEffort;
  /** Calls this run may make: three, less any an interrupted run of the same job already made. */
  readonly maxCalls?: number;
  /** Calls already made for the job, so the recorded attempt numbers continue. */
  readonly priorCalls?: number;
  readonly signal?: AbortSignal;
  /** Runs before every call: the worker renews its lease here. */
  readonly beforeCall?: () => Promise<void>;
  /** Runs after every call, before its answer is acted on: every attempt is billed, failed ones too. */
  readonly onCall?: (call: ListingCall) => Promise<void>;
  /** Milliseconds, for latency; `performance.now` by default. */
  readonly clock?: () => number;
}

interface Outcome<S extends string> {
  readonly status: S;
  readonly calls: readonly ListingCall[];
}

export type ListingOutcome =
  | (Outcome<'READY'> & { readonly draft: ListingDraft })
  | (Outcome<'NEEDS_REVIEW'> & {
      readonly draft: ListingWire | null;
      readonly issues: readonly ListingIssue[];
    })
  | (Outcome<'FAILED'> & { readonly failure: ListingFailure });

const TRUNCATED: ListingIssue = { path: '', message: 'The answer was cut off at the output limit.' };

function callRecord(
  attempt: number,
  effort: ListingEffort | null,
  result: AttemptResult,
  response: ModelResponse,
  requestedModel: string,
  latencyMs: number,
): ListingCall {
  const { usage } = response;
  return {
    attempt,
    model: response.model,
    effort,
    outcome: result.kind,
    stopReason: response.stop_reason,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    costUsd: callCostUsd(response, requestedModel),
    latencyMs: Math.max(0, Math.round(latencyMs)),
  };
}

function refusalFailure(category: string | null): ListingFailure {
  const suffix = category === null ? '' : ` (${category})`;
  return {
    reason: 'refusal',
    category,
    message: `The model declined to describe these photos${suffix}.`,
  };
}

export async function generateListing(options: GenerateOptions): Promise<ListingOutcome> {
  const { model, images, hints } = options;
  const maxCalls = options.maxCalls ?? MAX_LISTING_CALLS;
  if (maxCalls < 1 || maxCalls > MAX_LISTING_CALLS) throw new BugError(`maxCalls out of range: ${maxCalls}`);
  if (images.length === 0) throw new BugError('a listing needs at least one image');
  const clock = options.clock ?? (() => performance.now());
  const priorCalls = options.priorCalls ?? 0;

  const calls: ListingCall[] = [];
  const turns: ListingTurn[] = [];
  let effort = options.effort;
  let retriedAtLow = false;
  let best: ListingWire | null = null;
  let issues: readonly ListingIssue[] = [];
  const review = (): ListingOutcome => ({ status: 'NEEDS_REVIEW', draft: best, issues, calls });

  for (let call = 1; call <= maxCalls; call++) {
    await options.beforeCall?.();
    const started = clock();
    const response = await model.create({
      conversation: { images, hints, turns: [...turns] },
      effort,
      attempt: call,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const result = classifyResponse(response);
    const record = callRecord(
      priorCalls + call,
      model.usesEffort ? effort : null,
      result,
      response,
      model.model,
      clock() - started,
    );
    calls.push(record);
    await options.onCall?.(record);

    switch (result.kind) {
      case 'ok':
        return { status: 'READY', draft: result.draft, calls };
      case 'refusal':
        return { status: 'FAILED', failure: refusalFailure(result.category), calls };
      case 'truncated':
        issues = best === null ? [TRUNCATED] : issues;
        if (model.usesEffort && effort !== 'low' && !retriedAtLow) {
          effort = 'low';
          retriedAtLow = true;
          continue;
        }
        return review();
      case 'invalid':
        issues = result.issues;
        if (result.wire !== null) best = result.wire;
        if (result.needsHuman) return review();
        turns.push({ assistant: response.content, repair: repairInstruction(result.feedback) });
    }
  }
  return review();
}
