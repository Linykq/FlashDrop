import {
  ListingDraft,
  type ListingIssue,
  ListingWire,
  listingFieldPath,
  REQUIRED_ATTRIBUTE_RULE,
  repairListing,
} from '@flashdrop/contracts';
import { z } from 'zod';
import { type ModelResponse, responseText } from './response';

/*
 * One model answer, classified (design §10). The stop reason is read first, then the text is parsed
 * inside a `safeParse`, so no answer can throw before its usage is recorded: a refusal is usually plain
 * text and a `max_tokens` stop leaves truncated JSON.
 */

export type AttemptResult =
  | { readonly kind: 'refusal'; readonly category: string | null }
  | { readonly kind: 'truncated' }
  | {
      readonly kind: 'invalid';
      /** `z.prettifyError` output (path-level) for the repair turn. */
      readonly feedback: string;
      readonly issues: readonly ListingIssue[];
      /** The answer when it had the right shape and only broke `ListingDraft` rules: the review fallback. */
      readonly wire: ListingWire | null;
      /**
       * Every issue is a required attribute the model listed as uncertain. Asking again cannot fix that
       * without inviting a guess, so the job goes to review instead of spending the repair calls.
       */
      readonly needsHuman: boolean;
    }
  | { readonly kind: 'ok'; readonly draft: ListingDraft };

const NOT_JSON = 'Output was not valid JSON.';

function issuesOf(error: z.ZodError): ListingIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function isUncertainRequiredAttribute(issue: z.core.$ZodIssue, wire: ListingWire): boolean {
  if (issue.code !== 'custom' || issue.params?.rule !== REQUIRED_ATTRIBUTE_RULE) return false;
  const path = issue.path.join('.');
  return wire.uncertainties.some((uncertainty) => listingFieldPath(uncertainty.field) === path);
}

export function classifyResponse(response: ModelResponse): AttemptResult {
  if (response.stop_reason === 'refusal') {
    return { kind: 'refusal', category: response.stop_details?.category ?? null };
  }
  // The output was cut off either way; a context-window stop cannot happen at listing sizes, but would
  // leave the same truncated JSON.
  if (response.stop_reason === 'max_tokens' || response.stop_reason === 'model_context_window_exceeded') {
    return { kind: 'truncated' };
  }

  let json: unknown;
  try {
    json = JSON.parse(responseText(response));
  } catch {
    return {
      kind: 'invalid',
      feedback: NOT_JSON,
      issues: [{ path: '', message: NOT_JSON }],
      wire: null,
      needsHuman: false,
    };
  }
  const wire = ListingWire.safeParse(json);
  if (!wire.success) {
    return {
      kind: 'invalid',
      feedback: z.prettifyError(wire.error),
      issues: issuesOf(wire.error),
      wire: null,
      needsHuman: false,
    };
  }
  const draft = ListingDraft.safeParse(wire.data);
  if (draft.success) return { kind: 'ok', draft: draft.data };
  return {
    kind: 'invalid',
    feedback: z.prettifyError(draft.error),
    issues: issuesOf(draft.error),
    wire: repairListing(wire.data),
    needsHuman: draft.error.issues.every((issue) => isUncertainRequiredAttribute(issue, wire.data)),
  };
}
