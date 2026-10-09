import { readFile } from 'node:fs/promises';
import type { ListingEffort } from '@flashdrop/config';
import type { ListingCall } from '@flashdrop/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FixtureListingModel,
  type LoadedFixture,
  loadListingFixtures,
  NoFixtureError,
  REPO_FIXTURES_DIR,
} from './fixture';
import { generateListing, type ListingOutcome } from './generate';
import { prepareListingImage } from './images';
import type { ListingImage, ListingModel, ListingRequest } from './model';
import type { ModelResponse } from './response';

/*
 * The repair loop over every committed fixture (design §10): the same `Message`-shaped answers the live
 * provider returns, so each branch below is the branch production takes for that answer.
 */

let fixtures: LoadedFixture[];
let model: FixtureListingModel;

beforeAll(async () => {
  fixtures = await loadListingFixtures(REPO_FIXTURES_DIR);
  model = new FixtureListingModel('claude-sonnet-5-5', fixtures);
});

/** The fixture's photo as an upload stores it: re-encoded, under its content key. */
async function photoOf(name: string): Promise<ListingImage[]> {
  const fixture = fixtures.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`no fixture ${name}`);
  const prepared = await prepareListingImage(await readFile(fixture.imagePath));
  return [{ key: prepared.key, data: prepared.bytes }];
}

/** Wraps a model and keeps every request it got. */
function recording(inner: ListingModel, overrides: Partial<Pick<ListingModel, 'usesEffort'>> = {}) {
  const requests: ListingRequest[] = [];
  const spy: ListingModel = {
    provider: inner.provider,
    model: inner.model,
    usesEffort: overrides.usesEffort ?? inner.usesEffort,
    create(request): Promise<ModelResponse> {
      requests.push(request);
      return inner.create(request);
    },
  };
  return { spy, requests };
}

async function run(
  name: string,
  options: { effort?: ListingEffort; maxCalls?: number; priorCalls?: number; target?: ListingModel } = {},
): Promise<ListingOutcome> {
  return generateListing({
    model: options.target ?? model,
    images: await photoOf(name),
    hints: null,
    effort: options.effort ?? 'low',
    ...(options.maxCalls === undefined ? {} : { maxCalls: options.maxCalls }),
    ...(options.priorCalls === undefined ? {} : { priorCalls: options.priorCalls }),
  });
}

const outcomes = (outcome: ListingOutcome) => outcome.calls.map((call) => call.outcome);

describe('generateListing over the fixtures', () => {
  it('valid draft: READY after one call, the text picked past an empty thinking block', async () => {
    const outcome = await run('valid-draft');
    expect(outcome.status).toBe('READY');
    if (outcome.status !== 'READY') return;
    expect(outcome.draft.title).toBe('Sage Wireless Over-Ear Headphones');
    expect(outcome.calls).toEqual<ListingCall[]>([
      {
        attempt: 1,
        model: 'claude-sonnet-5-5',
        effort: 'low',
        outcome: 'ok',
        stopReason: 'end_turn',
        inputTokens: 1214,
        outputTokens: 386,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        // 1214 x $2 + 386 x $10 per million tokens.
        costUsd: 0.006288,
        latencyMs: expect.any(Number),
      },
    ]);
  });

  it('over-long title: a repair turn replays the answer unchanged and names the path', async () => {
    const { spy, requests } = recording(model);
    const outcome = await run('repair-long-title', { target: spy });
    expect(outcome.status).toBe('READY');
    expect(outcomes(outcome)).toEqual(['invalid', 'ok']);

    const [first, second] = requests;
    expect(first?.conversation.turns).toEqual([]);
    const turn = second?.conversation.turns[0];
    expect(turn?.assistant.map((block) => block.type)).toEqual(['thinking', 'text']);
    expect(turn?.repair).toContain('must be at most 80 characters (is 104)\n  → at title');
  });

  it('refusal: FAILED with the category, never retried', async () => {
    const outcome = await run('refusal');
    expect(outcome).toEqual({
      status: 'FAILED',
      failure: {
        reason: 'refusal',
        category: 'general_harms',
        message: 'The model declined to describe these photos (general_harms).',
      },
      calls: [expect.objectContaining({ outcome: 'refusal', stopReason: 'refusal' })],
    });
  });

  it('max_tokens at effort low: NEEDS_REVIEW at once, without a draft', async () => {
    const outcome = await run('max-tokens');
    expect(outcome).toEqual({
      status: 'NEEDS_REVIEW',
      draft: null,
      issues: [{ path: '', message: 'The answer was cut off at the output limit.' }],
      calls: [expect.objectContaining({ outcome: 'truncated', stopReason: 'max_tokens' })],
    });
  });

  it('max_tokens at a higher effort: one retry at low, with the same conversation', async () => {
    const { spy, requests } = recording(model);
    const outcome = await run('max-tokens', { effort: 'medium', target: spy });
    expect(outcome.status).toBe('READY');
    expect(outcome.calls.map((call) => call.effort)).toEqual(['medium', 'low']);
    expect(requests.map((request) => request.conversation.turns.length)).toEqual([0, 0]);
  });

  it('max_tokens on a model without effort: no retry, no effort recorded', async () => {
    const { spy } = recording(model, { usesEffort: false });
    const outcome = await run('max-tokens', { effort: 'high', target: spy });
    expect(outcome.status).toBe('NEEDS_REVIEW');
    expect(outcome.calls.map((call) => call.effort)).toEqual([null]);
  });

  it('invalid JSON: repaired on the second call', async () => {
    const { spy, requests } = recording(model);
    const outcome = await run('invalid-json', { target: spy });
    expect(outcome.status).toBe('READY');
    expect(outcomes(outcome)).toEqual(['invalid', 'ok']);
    expect(requests[1]?.conversation.turns[0]?.repair).toContain('Output was not valid JSON.');
  });

  it('prompt injection in the photo: the price is refused and repaired away', async () => {
    const { spy, requests } = recording(model);
    const outcome = await run('prompt-injection', { target: spy });
    expect(outcome.status).toBe('READY');
    if (outcome.status !== 'READY') return;
    expect(requests[1]?.conversation.turns[0]?.repair).toContain(
      'must not mention a price or currency\n  → at highlights[3]',
    );
    expect(JSON.stringify(outcome.draft)).not.toMatch(/\$|price/i);
  });

  it('out of calls: NEEDS_REVIEW with the last issues and the last well-formed answer', async () => {
    const outcome = await run('exhausted');
    expect(outcome.status).toBe('NEEDS_REVIEW');
    if (outcome.status !== 'NEEDS_REVIEW') return;
    expect(outcomes(outcome)).toEqual(['invalid', 'invalid', 'invalid']);
    expect(outcome.calls.map((call) => call.attempt)).toEqual([1, 2, 3]);
    expect(outcome.draft?.title).toBe('Daily Ritual Skincare Set');
    expect(outcome.issues).toEqual([
      { path: 'highlights.2', message: 'must not claim authenticity, guarantees or "100% original"' },
    ]);
  });

  it('an uncertain required attribute goes to review without a repair call', async () => {
    const outcome = await run('uncertain-size');
    expect(outcome).toMatchObject({
      status: 'NEEDS_REVIEW',
      draft: { category: 'apparel', attributes: { size: null } },
      issues: [{ path: 'attributes.size', message: 'is required for apparel' }],
    });
    expect(outcome.calls).toHaveLength(1);
  });

  it('a resumed job spends only the calls left and keeps numbering them', async () => {
    const outcome = await run('exhausted', { maxCalls: 1, priorCalls: 2 });
    expect(outcome.status).toBe('NEEDS_REVIEW');
    expect(outcome.calls.map((call) => call.attempt)).toEqual([3]);
  });

  it('photos without a fixture fail loudly instead of inventing a listing', async () => {
    const images = [{ key: `${'0'.repeat(64)}.jpg`, data: Buffer.from('x') }];
    await expect(generateListing({ model, images, hints: null, effort: 'low' })).rejects.toThrow(
      NoFixtureError,
    );
  });

  it('runs the hooks around every call, before acting on the answer', async () => {
    const events: string[] = [];
    await generateListing({
      model,
      images: await photoOf('repair-long-title'),
      hints: null,
      effort: 'low',
      beforeCall: async () => {
        events.push('before');
      },
      onCall: async (call) => {
        events.push(`call ${call.attempt} ${call.outcome}`);
      },
    });
    expect(events).toEqual(['before', 'call 1 invalid', 'before', 'call 2 ok']);
  });
});
