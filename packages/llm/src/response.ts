import { z } from 'zod';

/*
 * A model answer in the shape of the Messages API's `Message` (design §10): `model`, `content`,
 * `stop_reason`, `stop_details` and `usage`. The Anthropic provider maps its responses into it and the
 * fixtures are stored in it, so the attempt code runs exactly the same branches in CI as in production.
 * Fixture files are a boundary and are validated with these schemas.
 */

const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
// Thinking blocks are replayed unchanged in the repair turn: dropping or editing them can fail the request.
const ThinkingBlock = z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string() });
const RedactedThinkingBlock = z.object({ type: z.literal('redacted_thinking'), data: z.string() });
/** Where a server-side refusal fallback switched models mid-answer; replayed where it appeared. */
const FallbackBlock = z.object({
  type: z.literal('fallback'),
  from: z.object({ model: z.string() }),
  to: z.object({ model: z.string() }),
});

/**
 * Any other block, by its type only. No tools are offered, so none is expected; one the API adds later must
 * not throw before the call's usage is recorded (every attempt is billed, §10). It carries no text, and the
 * repair turn leaves it out of the replay.
 */
const OtherBlock = z.object({ type: z.literal('other'), kind: z.string() });

/** The blocks a listing answer can hold. */
export const ResponseBlock = z.discriminatedUnion('type', [
  TextBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  FallbackBlock,
  OtherBlock,
]);
export type ResponseBlock = z.infer<typeof ResponseBlock>;
/** The blocks the repair turn replays as the assistant's answer. */
export type ReplayedBlock = Exclude<ResponseBlock, { type: 'other' }>;

export function isReplayed(block: ResponseBlock): block is ReplayedBlock {
  return block.type !== 'other';
}

const tokens = z.int().nonnegative();

/** One model's share of a call when a fallback ran (`usage.iterations`). */
export const UsageIteration = z.object({
  type: z.string(),
  model: z.string().nullable().optional(),
  input_tokens: tokens,
  output_tokens: tokens,
  cache_creation_input_tokens: tokens.nullable().optional(),
  cache_read_input_tokens: tokens.nullable().optional(),
});
export type UsageIteration = z.infer<typeof UsageIteration>;

export const ResponseUsage = z.object({
  input_tokens: tokens,
  output_tokens: tokens,
  cache_creation_input_tokens: tokens.nullable().optional(),
  cache_read_input_tokens: tokens.nullable().optional(),
  iterations: z.array(UsageIteration).nullable().optional(),
});
export type ResponseUsage = z.infer<typeof ResponseUsage>;

export const ModelResponse = z.object({
  /** The model that answered; differs from the requested one after a refusal fallback. */
  model: z.string(),
  content: z.array(ResponseBlock),
  stop_reason: z.string().nullable(),
  stop_details: z
    .object({ category: z.string().nullable(), explanation: z.string().nullable().optional() })
    .nullable(),
  usage: ResponseUsage,
});
export type ModelResponse = z.infer<typeof ModelResponse>;

/**
 * The answer's text, picked by block type and never by position: a response can open with an empty
 * thinking block. Several text blocks (split by a fallback mid-answer) are joined in order.
 */
export function responseText(response: ModelResponse): string {
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
