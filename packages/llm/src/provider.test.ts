import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicListingModel } from './anthropic';
import { createFixtureListingModel, FixtureListingModel, REPO_FIXTURES_DIR } from './fixture';
import { generateListing } from './generate';
import { prepareListingImage } from './images';
import type { ListingModel } from './model';
import { createListingModel } from './provider';
import { RecordingListingModel } from './recording';

const logger = () => ({ info: vi.fn(), warn: vi.fn() });
const settings = { LISTING_MODEL: 'claude-sonnet-5-5', LLM_RECORD: false } as const;

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('createListingModel', () => {
  it('answers from the fixtures without a key, and says so at startup', async () => {
    const log = logger();
    const model = await createListingModel(
      { ...settings, LLM_PROVIDER: 'fixture' },
      { fixturesDir: REPO_FIXTURES_DIR, logger: log },
    );
    expect(model).toBeInstanceOf(FixtureListingModel);
    expect(model.model).toBe('claude-sonnet-5-5');
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('calls Anthropic with a key, and records when LLM_RECORD is on', async () => {
    const options = { fixturesDir: REPO_FIXTURES_DIR, logger: logger() };
    const live = { ...settings, LLM_PROVIDER: 'anthropic' as const, ANTHROPIC_API_KEY: 'sk-ant-test' };
    expect(await createListingModel(live, options)).toBeInstanceOf(AnthropicListingModel);
    expect(await createListingModel({ ...live, LLM_RECORD: true }, options)).toBeInstanceOf(
      RecordingListingModel,
    );
  });
});

describe('RecordingListingModel', () => {
  it('writes fixtures that the fixture provider then answers from', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fd-llm-record-'));
    temporary.push(dir);
    // Stands in for the live model: the committed answers of the repair fixture.
    const committed = await createFixtureListingModel({
      fixturesDir: REPO_FIXTURES_DIR,
      model: 'claude-sonnet-5-5',
    });
    const vase = await prepareListingImage(await readFile(join(REPO_FIXTURES_DIR, 'images', 'vase.jpg')));
    const images = [{ key: vase.key, data: vase.bytes }];
    const live: ListingModel = committed;

    const recorded = await generateListing({
      model: new RecordingListingModel(live, dir),
      images,
      hints: null,
      effort: 'low',
    });
    expect(recorded.status).toBe('READY');
    expect(await readdir(join(dir, 'llm'))).toEqual([`recorded-${vase.key.slice(0, 12)}.json`]);

    const replayed = await generateListing({
      model: await createFixtureListingModel({ fixturesDir: dir, model: 'claude-sonnet-5-5' }),
      images,
      hints: null,
      effort: 'low',
    });
    expect(replayed).toEqual({ ...recorded, calls: replayed.calls });
    expect(replayed.calls.map((call) => call.outcome)).toEqual(['invalid', 'ok']);
  });
});
