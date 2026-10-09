import { describe, expect, it } from 'vitest';
import { callCostUsd } from './models';
import type { ModelResponse } from './response';

const response = (model: string, usage: ModelResponse['usage']): ModelResponse => ({
  model,
  content: [],
  stop_reason: 'end_turn',
  stop_details: null,
  usage,
});

describe('callCostUsd', () => {
  it('prices input, output, cache writes (1.25x input) and cache reads', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_creation_input_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
    };
    // Sonnet 5.5: $2 + $1 + $0.25 + $0.20.
    expect(callCostUsd(response('claude-sonnet-5-5', usage), 'claude-sonnet-5-5')).toBe(3.45);
    // Haiku 4.5: $1 + $0.5 + $0.125 + $0.10.
    expect(callCostUsd(response('claude-haiku-4-5', usage), 'claude-haiku-4-5')).toBe(1.725);
  });

  it('is null when a model that ran has no price', () => {
    expect(
      callCostUsd(response('claude-unknown-9', { input_tokens: 10, output_tokens: 10 }), 'claude-unknown-9'),
    ).toBeNull();
  });

  it('prices an iteration without a model as the requested one', () => {
    const usage = {
      input_tokens: 2_000,
      output_tokens: 0,
      iterations: [{ type: 'message', model: null, input_tokens: 2_000, output_tokens: 0 }],
    };
    expect(callCostUsd(response('claude-opus-5-5', usage), 'claude-opus-5-5')).toBe(0.008);
  });
});
