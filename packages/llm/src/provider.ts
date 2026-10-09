import type { LlmProvider, Logger } from '@flashdrop/config';
import { BugError } from '@flashdrop/domain';
import { createAnthropicListingModel } from './anthropic';
import { createFixtureListingModel } from './fixture';
import type { ListingModel } from './model';
import { RecordingListingModel } from './recording';

/** The `LlmEnv` settings the provider choice reads (packages/config). */
export interface ListingModelSettings {
  readonly LLM_PROVIDER: LlmProvider;
  readonly LISTING_MODEL: string;
  readonly ANTHROPIC_API_KEY?: string | undefined;
  readonly LLM_RECORD: boolean;
}

/**
 * The provider `LLM_PROVIDER` selects, once at startup (design §10). `LlmEnv` resolves an unset provider
 * to `fixture` without a key, so a fresh clone and CI run without any secret; that choice is logged as a
 * warning, because live photos then fail with "no recorded listing".
 */
export async function createListingModel(
  settings: ListingModelSettings,
  options: { readonly fixturesDir: string; readonly logger: Pick<Logger, 'info' | 'warn'> },
): Promise<ListingModel> {
  const { fixturesDir, logger } = options;
  if (settings.LLM_PROVIDER === 'fixture') {
    logger.warn(
      { provider: 'fixture', fixturesDir },
      'listing generator answers from recorded fixtures (no ANTHROPIC_API_KEY, or LLM_PROVIDER=fixture): ' +
        'only the fixture photos produce drafts',
    );
    return createFixtureListingModel({ fixturesDir, model: settings.LISTING_MODEL });
  }
  // LlmEnv refuses LLM_PROVIDER=anthropic without a key.
  if (settings.ANTHROPIC_API_KEY === undefined) throw new BugError('LLM_PROVIDER=anthropic without a key');
  const live = createAnthropicListingModel({
    apiKey: settings.ANTHROPIC_API_KEY,
    model: settings.LISTING_MODEL,
  });
  if (settings.LLM_RECORD) {
    logger.warn(
      { provider: 'anthropic', fixturesDir },
      'LLM_RECORD is on: every listing answer is written as a fixture',
    );
    return new RecordingListingModel(live, fixturesDir);
  }
  logger.info({ provider: 'anthropic', model: settings.LISTING_MODEL }, 'listing generator calls Anthropic');
  return live;
}
