import Anthropic from '@anthropic-ai/sdk';
import type * as Messages from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { TransientError } from '@flashdrop/domain';
import type { ListingConversation, ListingModel, ListingRequest } from './model';
import { EFFORT_MODELS, FALLBACK_MODELS } from './models';
import { LISTING_SYSTEM_PROMPT, listingInstruction } from './prompt';
import { isReplayed, type ModelResponse, type ReplayedBlock, type ResponseBlock } from './response';
import { LISTING_WIRE_FORMAT } from './schema';

/*
 * The live provider (design §10). Requests go through `beta.messages.create` because the server-side
 * refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) exists only there in
 * @anthropic-ai/sdk 0.131.0; `output_config` (format and effort) is the same object on both endpoints.
 *
 * - `create`, never `parse`: `parse` throws on a refusal, a truncation or a schema mismatch before the code
 *   can read `stop_reason` or record the attempt's usage (§10).
 * - No `thinking` parameter: Sonnet 5.5 and Opus 5.5 think adaptively and reject `disabled`; less thinking
 *   means a lower effort, sent only to the models that take it.
 * - No assistant prefill: every request ends with a user turn.
 * - 16k output tokens, non-streaming, with a 5-minute timeout per request; the SDK retries 408, 409, 429,
 *   5xx and connection errors twice.
 */

const MAX_TOKENS = 16_000;
const REQUEST_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 2;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The part of the SDK client this provider calls; tests pass a mock. */
export interface ListingMessagesApi {
  create(
    body: Messages.MessageCreateParamsNonStreaming,
    options: { readonly timeout: number; readonly signal?: AbortSignal },
  ): PromiseLike<Messages.BetaMessage>;
}

function toBlockParam(block: ReplayedBlock): Messages.BetaContentBlockParam {
  return block;
}

/** The conversation as Messages API turns: photos first, then the instruction; each repair round after. */
export function listingMessages(conversation: ListingConversation): Messages.BetaMessageParam[] {
  const first: Messages.BetaMessageParam = {
    role: 'user',
    content: [
      ...conversation.images.map(
        (image): Messages.BetaImageBlockParam => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: image.data.toString('base64') },
        }),
      ),
      { type: 'text', text: listingInstruction(conversation.hints, conversation.images.length) },
    ],
  };
  return [
    first,
    ...conversation.turns.flatMap((turn): Messages.BetaMessageParam[] => [
      // Replayed exactly as answered, thinking blocks included: removing them can fail the request. Only a
      // block of a type this code does not know is left out: it has nothing to replay it from.
      { role: 'assistant', content: turn.assistant.filter(isReplayed).map(toBlockParam) },
      { role: 'user', content: turn.repair },
    ]),
  ];
}

export function listingRequestBody(
  model: string,
  request: ListingRequest,
): Messages.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: LISTING_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: listingMessages(request.conversation),
    output_config: {
      format: LISTING_WIRE_FORMAT,
      ...(EFFORT_MODELS.has(model) ? { effort: request.effort } : {}),
    },
    ...(FALLBACK_MODELS.has(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  };
}

function toResponseBlock(block: Messages.BetaContentBlock): ResponseBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data };
    case 'fallback':
      return { type: 'fallback', from: { model: block.from.model }, to: { model: block.to.model } };
    default:
      // The request offers no tools, so nothing else is expected; a type added to the API later is kept by
      // name, never thrown on, so the call's usage is still recorded.
      return { type: 'other', kind: block.type };
  }
}

export function toModelResponse(message: Messages.BetaMessage): ModelResponse {
  const { usage } = message;
  return {
    model: message.model,
    content: message.content.map(toResponseBlock),
    stop_reason: message.stop_reason,
    stop_details:
      message.stop_details === null
        ? null
        : { category: message.stop_details.category, explanation: message.stop_details.explanation },
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      iterations:
        usage.iterations?.map((part) => ({
          type: part.type,
          model: 'model' in part ? part.model : null,
          input_tokens: part.input_tokens,
          output_tokens: part.output_tokens,
          cache_creation_input_tokens: part.cache_creation_input_tokens,
          cache_read_input_tokens: part.cache_read_input_tokens,
        })) ?? null,
    },
  };
}

/** Errors worth retrying later, after the SDK's own retries: rate limits, overload and the network. */
function isRetryableLater(error: unknown): error is Error {
  return (
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError ||
    // Includes APIConnectionTimeoutError. A shutdown's abort is APIUserAbortError, a sibling class.
    error instanceof Anthropic.APIConnectionError
  );
}

export class AnthropicListingModel implements ListingModel {
  readonly provider = 'anthropic';
  readonly model: string;
  readonly usesEffort: boolean;
  readonly #api: ListingMessagesApi;

  constructor(model: string, api: ListingMessagesApi) {
    this.model = model;
    this.usesEffort = EFFORT_MODELS.has(model);
    this.#api = api;
  }

  async create(request: ListingRequest): Promise<ModelResponse> {
    let message: Messages.BetaMessage;
    try {
      message = await this.#api.create(listingRequestBody(this.model, request), {
        timeout: REQUEST_TIMEOUT_MS,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      if (isRetryableLater(error)) {
        throw new TransientError(`Anthropic is unavailable: ${error.message}`, { cause: error });
      }
      throw error;
    }
    return toModelResponse(message);
  }
}

export function createAnthropicListingModel(options: {
  readonly apiKey: string;
  readonly model: string;
}): AnthropicListingModel {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: MAX_RETRIES });
  return new AnthropicListingModel(options.model, client.beta.messages);
}
