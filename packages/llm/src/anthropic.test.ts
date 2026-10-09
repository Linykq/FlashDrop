import Anthropic from '@anthropic-ai/sdk';
import type * as Messages from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { TransientError } from '@flashdrop/domain';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicListingModel, type ListingMessagesApi } from './anthropic';
import { generateListing } from './generate';
import type { ListingImage, ListingRequest } from './model';
import { LISTING_SYSTEM_PROMPT } from './prompt';
import { LISTING_WIRE_FORMAT } from './schema';

/*
 * The live provider against a mocked SDK client (design §10): the request it builds and how it reads each
 * kind of answer. No test here, and nothing in CI, ever needs an API key.
 */

const IMAGE: ListingImage = { key: `${'a'.repeat(64)}.jpg`, data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };

const LISTING = {
  title: 'Sage Wireless Over-Ear Headphones',
  description:
    'Over-ear wireless headphones in a soft sage green with ivory accents and cushioned ear cups, on a slim ' +
    'adjustable frame with a padded band.',
  highlights: ['Cushioned ear cups', 'Padded adjustable headband', 'Matte sage finish'],
  category: 'audio',
  attributes: { brand: null, color: 'Sage', material: null, size: null },
  condition: 'new',
  tags: ['headphones'],
  uncertainties: [],
};

function usage(overrides: Partial<Messages.BetaUsage> = {}): Messages.BetaUsage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    fallback_credit: null,
    inference_geo: null,
    input_tokens: 1000,
    iterations: null,
    output_tokens: 300,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: 'standard',
    speed: 'standard',
    ...overrides,
  };
}

function message(overrides: Partial<Messages.BetaMessage>): Messages.BetaMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    container: null,
    context_management: null,
    diagnostics: null,
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: JSON.stringify(LISTING), citations: null },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: usage(),
    ...overrides,
  };
}

function mockApi(...answers: (Messages.BetaMessage | Error)[]) {
  const create = vi.fn<ListingMessagesApi['create']>();
  for (const answer of answers) {
    if (answer instanceof Error) create.mockRejectedValueOnce(answer);
    else create.mockResolvedValueOnce(answer);
  }
  return { create };
}

const request = (overrides: Partial<ListingRequest> = {}): ListingRequest => ({
  conversation: { images: [IMAGE], hints: null, turns: [] },
  effort: 'low',
  attempt: 1,
  ...overrides,
});

describe('AnthropicListingModel request', () => {
  it('sends structured output, effort and the refusal fallback on Sonnet 5.5, and never `thinking`', async () => {
    const api = mockApi(message({}));
    const signal = new AbortController().signal;
    await new AnthropicListingModel('claude-sonnet-5-5', api).create(request({ signal }));

    const [body, options] = api.create.mock.calls[0] ?? [];
    expect(body).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 16_000,
      system: [{ type: 'text', text: LISTING_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/2Q==' } },
            { type: 'text', text: 'Write the listing for the product in the photo above.' },
          ],
        },
      ],
      output_config: { format: LISTING_WIRE_FORMAT, effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(body).not.toHaveProperty('thinking');
    expect(options).toEqual({ timeout: 300_000, signal });
  });

  it('sends neither effort nor fallbacks to Haiku 4.5', async () => {
    const api = mockApi(message({ model: 'claude-haiku-4-5' }));
    const model = new AnthropicListingModel('claude-haiku-4-5', api);
    expect(model.usesEffort).toBe(false);
    await model.create(request({ effort: 'high' }));
    const [body] = api.create.mock.calls[0] ?? [];
    expect(body?.output_config).toEqual({ format: LISTING_WIRE_FORMAT });
    expect(body).not.toHaveProperty('betas');
    expect(body).not.toHaveProperty('fallbacks');
  });

  it('fences seller hints and replays a repair round unchanged, ending on the user turn', async () => {
    const api = mockApi(message({}));
    const assistant = [
      { type: 'thinking' as const, thinking: '', signature: 'sig-1' },
      { type: 'text' as const, text: '{"title":"x"}' },
    ];
    await new AnthropicListingModel('claude-sonnet-5-5', api).create(
      request({
        conversation: {
          images: [IMAGE, IMAGE],
          hints: 'linen, size M',
          turns: [{ assistant, repair: 'Fix it.' }],
        },
        attempt: 2,
      }),
    );
    const messages = api.create.mock.calls[0]?.[0].messages ?? [];
    expect(messages.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
    const first = messages[0]?.content;
    expect(Array.isArray(first) && first.at(-1)).toEqual({
      type: 'text',
      text:
        'Write the listing for the product in the 2 photos above (the first is the main one).\n\n' +
        '<seller_hints>\nlinen, size M\n</seller_hints>',
    });
    expect(messages[1]).toEqual({ role: 'assistant', content: assistant });
    expect(messages[2]).toEqual({ role: 'user', content: 'Fix it.' });
  });
});

describe('AnthropicListingModel answers', () => {
  const generate = (api: ListingMessagesApi, effort: 'low' | 'medium' = 'low') =>
    generateListing({
      model: new AnthropicListingModel('claude-sonnet-5-5', api),
      images: [IMAGE],
      hints: null,
      effort,
    });

  it('reads the text block by type, past a leading empty thinking block', async () => {
    const outcome = await generate(mockApi(message({})));
    expect(outcome.status).toBe('READY');
  });

  it('branches on stop_reason before reading content: a refusal keeps its category', async () => {
    const refusal = message({
      content: [],
      stop_reason: 'refusal',
      stop_details: {
        type: 'refusal',
        category: 'cyber',
        explanation: 'declined',
        fallback_credit_token: null,
        fallback_has_prefill_claim: null,
        recommended_model: null,
      },
    });
    const outcome = await generate(mockApi(refusal));
    expect(outcome).toMatchObject({ status: 'FAILED', failure: { reason: 'refusal', category: 'cyber' } });
  });

  it('a max_tokens stop is a truncation, retried once at low effort', async () => {
    const truncated = message({
      content: [{ type: 'text', text: '{"title":"Sage', citations: null }],
      stop_reason: 'max_tokens',
    });
    const api = mockApi(truncated, message({}));
    const outcome = await generate(api, 'medium');
    expect(outcome.status).toBe('READY');
    expect(api.create.mock.calls.map(([body]) => body.output_config?.effort)).toEqual(['medium', 'low']);
  });

  it('records the model that answered and prices each fallback iteration at its own rates', async () => {
    const fallback = message({
      model: 'claude-opus-4-8',
      content: [
        {
          type: 'fallback',
          from: { model: 'claude-sonnet-5-5' },
          to: { model: 'claude-opus-4-8' },
          trigger: { type: 'refusal', category: 'cyber' },
        },
        { type: 'text', text: JSON.stringify(LISTING), citations: null },
      ],
      usage: usage({
        input_tokens: 2000,
        output_tokens: 300,
        iterations: [
          {
            type: 'message',
            model: 'claude-sonnet-5-5',
            input_tokens: 1000,
            output_tokens: 0,
            cache_creation: null,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          {
            type: 'fallback_message',
            model: 'claude-opus-4-8',
            input_tokens: 1000,
            output_tokens: 300,
            cache_creation: null,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        ],
      }),
    });
    const outcome = await generate(mockApi(fallback));
    expect(outcome.status).toBe('READY');
    // Sonnet 5.5: 1000 x $2; Opus 4.8: 1000 x $5 + 300 x $25 (per million tokens).
    expect(outcome.calls[0]).toMatchObject({ model: 'claude-opus-4-8', costUsd: 0.0145 });
  });

  it('records the usage of an answer with a block it does not know, and leaves that block out of the replay', async () => {
    const unknown = message({
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'x', input: {}, caller: { type: 'direct' } },
        { type: 'text', text: '{"title":', citations: null },
      ],
    });
    const api = mockApi(unknown, message({}));
    const onCall = vi.fn();
    const outcome = await generateListing({
      model: new AnthropicListingModel('claude-sonnet-5-5', api),
      images: [IMAGE],
      hints: null,
      effort: 'low',
      onCall,
    });
    expect(outcome.status).toBe('READY');
    expect(onCall).toHaveBeenCalledTimes(2);
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, outcome: 'invalid', inputTokens: 1000 });
    expect(api.create.mock.calls[1]?.[0].messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '{"title":' }],
    });
  });
});

describe('AnthropicListingModel errors', () => {
  const create = (error: Error) =>
    new AnthropicListingModel('claude-sonnet-5-5', mockApi(error)).create(request());

  it('turns rate limits, overload and network failures into TransientError', async () => {
    const headers = new Headers();
    for (const error of [
      new Anthropic.RateLimitError(429, undefined, 'rate limited', headers),
      new Anthropic.InternalServerError(529, undefined, 'overloaded', headers),
      new Anthropic.APIConnectionTimeoutError(),
    ]) {
      await expect(create(error)).rejects.toThrow(TransientError);
    }
  });

  it('passes other failures through unchanged: a bad request, an abort', async () => {
    const badRequest = new Anthropic.BadRequestError(400, undefined, 'bad', new Headers());
    await expect(create(badRequest)).rejects.toBe(badRequest);
    const abort = new Anthropic.APIUserAbortError();
    await expect(create(abort)).rejects.toBe(abort);
  });
});
