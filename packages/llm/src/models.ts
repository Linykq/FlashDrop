import type { ModelResponse } from './response';

/*
 * What the listing generator knows about each model (design §10). A model missing here still works: it
 * gets no `effort`, no refusal fallback, and its calls are recorded with a null cost.
 */

/** Models that take `output_config.effort`: effort is an error on Haiku 4.5. */
export const EFFORT_MODELS: ReadonlySet<string> = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);

/**
 * Models that opt into the server-side refusal fallback (`fallbacks: "default"`, beta
 * `server-side-fallback-2026-07-01`, Claude API only).
 */
export const FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);

/** USD per million tokens. A cache write (5-minute TTL) costs 1.25 times the input price. */
interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

/** The configurable models, plus the earlier generations a refusal fallback may answer with. */
export const MODEL_PRICES: Readonly<Record<string, Price>> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
};

const CACHE_WRITE_FACTOR = 1.25;
const PER_TOKEN = 1 / 1_000_000;

interface TokenCounts {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null | undefined;
  readonly cache_read_input_tokens?: number | null | undefined;
}

function priced(model: string, counts: TokenCounts): number | null {
  const price = MODEL_PRICES[model];
  if (price === undefined) return null;
  return (
    (counts.input_tokens * price.input +
      counts.output_tokens * price.output +
      (counts.cache_creation_input_tokens ?? 0) * price.input * CACHE_WRITE_FACTOR +
      (counts.cache_read_input_tokens ?? 0) * price.cacheRead) *
    PER_TOKEN
  );
}

/**
 * The cost of one call in USD, null when a model that ran is not priced. When a fallback ran, each model's
 * share (`usage.iterations`) is priced at its own rates; an iteration without a model is the requested one.
 */
export function callCostUsd(response: ModelResponse, requestedModel: string): number | null {
  const { iterations } = response.usage;
  const parts =
    iterations !== null && iterations !== undefined && iterations.length > 0
      ? iterations.map((part) => ({ model: part.model ?? requestedModel, counts: part }))
      : [{ model: response.model, counts: response.usage }];
  let total = 0;
  for (const { model, counts } of parts) {
    const cost = priced(model, counts);
    if (cost === null) return null;
    total += cost;
  }
  // Micro-dollars: finer than the cost_usd column (numeric(10,5)), with no float noise in the logs.
  return Math.round(total * 1_000_000) / 1_000_000;
}
