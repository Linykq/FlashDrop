import { CoreEnv, type EnvSource, loadEnv, PspDatabaseEnv, PspEnv } from '@flashdrop/config';
import { z } from 'zod';

/** Loopback on 4100 by default (§15); Compose sets `HOST=0.0.0.0` for the consumers on its network. */
export const ListenEnv = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z
    .string()
    .regex(/^\d+$/, 'must be a port number')
    .transform(Number)
    .pipe(z.int().min(1, 'must be a port number').max(65_535, 'must be a port number'))
    .default(4100),
});

/**
 * `PspEnv` brings `PSP_LATENCY_MS`, `PSP_ERROR_RATE` and `PSP_TIMEOUT_AFTER_SUCCESS_RATE`; `PspDatabaseEnv`
 * the ledger connection as the PSP's own role, never `DATABASE_URL` (design §3).
 */
export function loadPaymentMockEnv(source?: EnvSource) {
  return loadEnv([CoreEnv, PspEnv, PspDatabaseEnv, ListenEnv], source);
}

export type PaymentMockConfig = ReturnType<typeof loadPaymentMockEnv>;
