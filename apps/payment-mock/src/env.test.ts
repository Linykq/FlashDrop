import { describe, expect, it } from 'vitest';
import { loadPaymentMockEnv } from './env';

describe('loadPaymentMockEnv', () => {
  it('defaults to loopback on 4100, the PSP role on Compose Postgres, and the design failure rates', () => {
    expect(loadPaymentMockEnv({})).toMatchObject({
      HOST: '127.0.0.1',
      PORT: 4100,
      PSP_DATABASE_URL: 'postgres://flashdrop_psp:dev-only-psp-db-password@127.0.0.1:5433/flashdrop',
      PSP_LATENCY_MS: { minMs: 100, maxMs: 800 },
      PSP_ERROR_RATE: 0.02,
      PSP_TIMEOUT_AFTER_SUCCESS_RATE: 0.01,
    });
  });

  it('reads the failure modes and refuses bad values', () => {
    const env = loadPaymentMockEnv({ PSP_LATENCY_MS: '50', PSP_ERROR_RATE: '0.3', PORT: '4101' });
    expect(env).toMatchObject({ PSP_LATENCY_MS: { minMs: 50, maxMs: 50 }, PSP_ERROR_RATE: 0.3, PORT: 4101 });
    expect(() => loadPaymentMockEnv({ PSP_ERROR_RATE: '1.5' })).toThrow(/PSP_ERROR_RATE/);
    expect(() => loadPaymentMockEnv({ PSP_DATABASE_URL: 'mysql://x' })).toThrow(/PSP_DATABASE_URL/);
    expect(() => loadPaymentMockEnv({ PORT: '0' })).toThrow(/PORT/);
  });
});
