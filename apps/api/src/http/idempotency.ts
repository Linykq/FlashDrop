import { IDEMPOTENCY_KEY_HEADER, IdempotencyKey } from '@flashdrop/contracts';
import { z } from 'zod';

/**
 * The headers of a request that needs an `Idempotency-Key` (reserve and checkout submit, §4.5). Other headers
 * pass through untouched; only the key is required and checked: 8–64 of `[A-Za-z0-9_-]`. A custom header
 * also forces a CORS preflight, so a cross-site page cannot send these requests blind (§11).
 */
export const IdempotencyHeaders = z.looseObject({ [IDEMPOTENCY_KEY_HEADER]: IdempotencyKey });
