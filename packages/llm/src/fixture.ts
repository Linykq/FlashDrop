import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnprocessableInputError } from '@flashdrop/domain';
import { z } from 'zod';
import { prepareListingImage, sha256Hex } from './images';
import type { ListingModel, ListingRequest } from './model';
import { ModelResponse } from './response';

/*
 * The fixture provider (design §10): recorded `Message`-shaped answers keyed by image sha256, so CI and a
 * machine without a key run exactly the branches the live provider runs. A fixture is a JSON file in
 * `<fixtures>/llm/` naming a photo in `<fixtures>/images/` and the answers to the 1st, 2nd and 3rd call of
 * a job (the last one repeats).
 *
 * Each photo is keyed twice: by the sha256 of the file as committed, and by the sha256 of the JPEG the
 * upload pipeline makes of it on this machine. The second is computed at load time instead of being
 * recorded, because a re-encode is only reproducible with the same libvips build and CPU features; this
 * way uploading the committed photo through the API selects its fixture on any machine. The first matches
 * a job whose stored image is the committed file itself, which is what `RecordingListingModel` writes.
 */

/** `tests/fixtures` of this checkout, from the source tree. Bundled entries pass their own path. */
export const REPO_FIXTURES_DIR = fileURLToPath(new URL('../../../tests/fixtures', import.meta.url));

export const ListingFixture = z.object({
  /** What the fixture exercises, for the people reading it. */
  description: z.string().min(1),
  /** The photo in `images/` whose upload selects this fixture. */
  image: z.string().regex(/^[a-z0-9][a-z0-9-]*\.(?:jpg|jpeg|png|webp)$/),
  responses: z.array(ModelResponse).min(1),
});
export type ListingFixture = z.infer<typeof ListingFixture>;

export interface LoadedFixture extends ListingFixture {
  /** The file name without `.json`. */
  readonly name: string;
  readonly imagePath: string;
  /** sha256 of the committed photo and of its upload-pipeline JPEG. */
  readonly keys: readonly string[];
}

/** No fixture matches the job's photos: the job fails with this message instead of inventing a listing. */
export class NoFixtureError extends UnprocessableInputError {
  override name = 'NoFixtureError';
}

export async function loadListingFixtures(fixturesDir: string): Promise<LoadedFixture[]> {
  const dir = join(fixturesDir, 'llm');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  return Promise.all(
    files.map(async (file): Promise<LoadedFixture> => {
      const parsed = ListingFixture.safeParse(JSON.parse(await readFile(join(dir, file), 'utf8')));
      if (!parsed.success) throw new Error(`fixture ${file} is invalid:\n${z.prettifyError(parsed.error)}`);
      const imagePath = join(fixturesDir, 'images', parsed.data.image);
      const bytes = await readFile(imagePath);
      const prepared = await prepareListingImage(bytes);
      const keys = [...new Set([sha256Hex(bytes), prepared.sha256])];
      return { ...parsed.data, name: file.slice(0, -'.json'.length), imagePath, keys };
    }),
  );
}

export class FixtureListingModel implements ListingModel {
  readonly provider = 'fixture';
  // So the truncation branch's low-effort retry runs in CI too.
  readonly usesEffort = true;
  readonly model: string;
  readonly #byKey = new Map<string, LoadedFixture>();

  constructor(model: string, fixtures: readonly LoadedFixture[]) {
    this.model = model;
    for (const fixture of fixtures) {
      for (const key of fixture.keys) {
        const other = this.#byKey.get(key);
        if (other !== undefined) throw new Error(`fixtures ${other.name} and ${fixture.name} share a photo`);
        this.#byKey.set(key, fixture);
      }
    }
  }

  async create(request: ListingRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();
    for (const image of request.conversation.images) {
      const fixture = this.#byKey.get(image.key.slice(0, -'.jpg'.length));
      if (fixture === undefined) continue;
      const response = fixture.responses[Math.min(request.attempt, fixture.responses.length) - 1];
      // responses has at least one entry and attempt is 1-based, so the index is always in range.
      if (response !== undefined) return response;
    }
    throw new NoFixtureError(
      'No recorded listing matches these photos: with LLM_PROVIDER=fixture only the photos in ' +
        'tests/fixtures/images produce drafts. Set ANTHROPIC_API_KEY to generate live listings.',
    );
  }
}

export async function createFixtureListingModel(options: {
  readonly fixturesDir: string;
  readonly model: string;
}): Promise<FixtureListingModel> {
  return new FixtureListingModel(options.model, await loadListingFixtures(options.fixturesDir));
}
