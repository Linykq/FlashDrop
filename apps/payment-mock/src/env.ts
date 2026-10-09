import {
  CoreEnv,
  type EnvSource,
  listenEnv,
  loadEnv,
  PspAuthEnv,
  PspDatabaseEnv,
  PspEnv,
} from '@flashdrop/config';

/** Loopback on 4100 by default (§15); Compose sets `HOST=0.0.0.0` for the consumers on its network. */
export const ListenEnv = listenEnv(4100);

/**
 * `PspEnv` brings `PSP_LATENCY_MS`, `PSP_ERROR_RATE` and `PSP_TIMEOUT_AFTER_SUCCESS_RATE`; `PspAuthEnv` the
 * API key every `/v1/*` call must carry; `PspDatabaseEnv` the ledger connection as the PSP's own role, never
 * `DATABASE_URL` (design §3).
 */
export function loadPaymentMockEnv(source?: EnvSource) {
  return loadEnv([CoreEnv, PspEnv, PspAuthEnv, PspDatabaseEnv, ListenEnv], source);
}

export type PaymentMockConfig = ReturnType<typeof loadPaymentMockEnv>;
