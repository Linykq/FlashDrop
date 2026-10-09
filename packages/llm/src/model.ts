import type { ListingEffort, LlmProvider } from '@flashdrop/config';
import type { ImageKey } from '@flashdrop/contracts';
import type { ModelResponse, ResponseBlock } from './response';

/** A stored listing photo, as the model receives it: the re-encoded JPEG under its content key. */
export interface ListingImage {
  readonly key: ImageKey;
  readonly data: Buffer;
}

/** A repair round: the previous answer, replayed unchanged, and the rules it broke. */
export interface ListingTurn {
  readonly assistant: readonly ResponseBlock[];
  readonly repair: string;
}

/** Everything a call sends, provider-neutral: each provider renders it its own way. */
export interface ListingConversation {
  readonly images: readonly ListingImage[];
  readonly hints: string | null;
  readonly turns: readonly ListingTurn[];
}

export interface ListingRequest {
  readonly conversation: ListingConversation;
  readonly effort: ListingEffort;
  /** 1-based number of this call within the job; fixtures answer by it. */
  readonly attempt: number;
  readonly signal?: AbortSignal;
}

/**
 * One implementation per `LLM_PROVIDER` (design §10), chosen at startup; the repair loop always calls the
 * same one again. `create` resolves with the raw answer whatever its stop reason: only transport failures
 * reject, a `TransientError` when retrying later may succeed.
 */
export interface ListingModel {
  readonly provider: LlmProvider;
  /** The model requested (`LISTING_MODEL`). */
  readonly model: string;
  /** Whether the model takes `output_config.effort` (Haiku 4.5 does not). */
  readonly usesEffort: boolean;
  create(request: ListingRequest): Promise<ModelResponse>;
}
