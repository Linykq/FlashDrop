import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LlmProvider } from '@flashdrop/config';
import type { ListingFixture } from './fixture';
import type { ListingModel, ListingRequest } from './model';
import type { ModelResponse } from './response';

/*
 * `LLM_RECORD=1` (design §10, a stretch item): calls the live model and writes each job's answers as a
 * fixture, `<fixtures>/llm/recorded-<sha12>.json` beside a copy of its first stored photo in
 * `<fixtures>/images/`. That photo is the stored JPEG itself, so the fixture provider matches it by the
 * committed file's hash. Recorded fixtures are reviewed and renamed by hand before they are committed.
 */

export class RecordingListingModel implements ListingModel {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly usesEffort: boolean;
  readonly #live: ListingModel;
  readonly #fixturesDir: string;
  readonly #recorded = new Map<string, ModelResponse[]>();

  constructor(live: ListingModel, fixturesDir: string) {
    this.#live = live;
    this.#fixturesDir = fixturesDir;
    this.provider = live.provider;
    this.model = live.model;
    this.usesEffort = live.usesEffort;
  }

  async create(request: ListingRequest): Promise<ModelResponse> {
    const response = await this.#live.create(request);
    const [photo] = request.conversation.images;
    if (photo === undefined) return response;

    const name = `recorded-${photo.key.slice(0, 12)}`;
    const responses = this.#recorded.get(name) ?? [];
    // A job's calls are numbered from 1; a new job with the same photo starts the list again.
    if (request.attempt === 1) responses.length = 0;
    responses.push(response);
    this.#recorded.set(name, responses);

    const fixture: ListingFixture = {
      description: `Recorded from ${this.model} on ${new Date().toISOString().slice(0, 10)}.`,
      image: `${name}.jpg`,
      responses,
    };
    await mkdir(join(this.#fixturesDir, 'llm'), { recursive: true });
    await mkdir(join(this.#fixturesDir, 'images'), { recursive: true });
    await writeFile(join(this.#fixturesDir, 'images', `${name}.jpg`), photo.data);
    await writeFile(join(this.#fixturesDir, 'llm', `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    return response;
  }
}
