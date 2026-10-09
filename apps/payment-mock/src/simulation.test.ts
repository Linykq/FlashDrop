import { describe, expect, it } from 'vitest';
import {
  FLAKY_FAILURE_RATE,
  newChargeStatus,
  planCharge,
  planClose,
  type Simulation,
  SLOW_METHOD_DELAY_MS,
} from './simulation';

/** A simulation whose draws come from `values` in order (then 0.99, which triggers nothing). */
function draws(values: readonly number[], config: Partial<Simulation> = {}) {
  const queue = [...values];
  return {
    latency: { minMs: 100, maxMs: 800 },
    errorRate: 0,
    timeoutAfterSuccessRate: 0,
    random: () => queue.shift() ?? 0.99,
    ...config,
  };
}

describe('planCharge', () => {
  it('draws the latency uniformly within the configured range, bounds included', () => {
    expect(planCharge('pm_ok', draws([0])).delayMs).toBe(100);
    expect(planCharge('pm_ok', draws([0.999_999])).delayMs).toBe(800);
    expect(planCharge('pm_ok', draws([0.5], { latency: { minMs: 50, maxMs: 50 } })).delayMs).toBe(50);
  });

  it('adds pm_slow processing time that stays under a 5 s client timeout', () => {
    const plan = planCharge('pm_slow', draws([0.999_999]));
    expect(plan.delayMs).toBe(800 + SLOW_METHOD_DELAY_MS);
    expect(plan.delayMs).toBeLessThan(5_000);
  });

  it('fails before recording at PSP_ERROR_RATE and withholds at PSP_TIMEOUT_AFTER_SUCCESS_RATE', () => {
    const config = { errorRate: 0.1, timeoutAfterSuccessRate: 0.2 };
    // Draws: latency, error, withhold.
    expect(planCharge('pm_ok', draws([0, 0.05, 0.5], config))).toMatchObject({
      failBeforeRecording: true,
      withholdSuccess: false,
    });
    expect(planCharge('pm_ok', draws([0, 0.5, 0.15], config))).toMatchObject({
      failBeforeRecording: false,
      withholdSuccess: true,
    });
    expect(planCharge('pm_ok', draws([0, 0.1, 0.2], config))).toMatchObject({
      failBeforeRecording: false,
      withholdSuccess: false,
    });
  });

  it('never fails or withholds at rate 0, and always does at rate 1', () => {
    expect(planCharge('pm_ok', draws([0, 0, 0]))).toMatchObject({
      failBeforeRecording: false,
      withholdSuccess: false,
    });
    const always = { errorRate: 1, timeoutAfterSuccessRate: 1 };
    expect(planCharge('pm_ok', draws([0, 0.999_999, 0.999_999], always))).toMatchObject({
      failBeforeRecording: true,
      withholdSuccess: true,
    });
  });

  it('splits pm_flaky attempts into a 503, a withheld success, and a normal answer', () => {
    // Draws: flaky, latency, error, withhold.
    expect(planCharge('pm_flaky', draws([FLAKY_FAILURE_RATE - 0.01]))).toMatchObject({
      failBeforeRecording: true,
      withholdSuccess: false,
    });
    expect(planCharge('pm_flaky', draws([FLAKY_FAILURE_RATE]))).toMatchObject({
      failBeforeRecording: false,
      withholdSuccess: true,
    });
    expect(planCharge('pm_flaky', draws([2 * FLAKY_FAILURE_RATE]))).toMatchObject({
      failBeforeRecording: false,
      withholdSuccess: false,
    });
  });
});

describe('planClose', () => {
  it('has latency and PSP_ERROR_RATE, and is never withheld', () => {
    expect(planClose(draws([0, 0.05], { errorRate: 0.1, timeoutAfterSuccessRate: 1 }))).toEqual({
      delayMs: 100,
      failBeforeRecording: true,
      withholdSuccess: false,
    });
  });
});

describe('newChargeStatus', () => {
  it('declines pm_decline only', () => {
    expect(newChargeStatus('pm_decline')).toBe('declined');
    for (const method of ['pm_ok', 'pm_slow', 'pm_flaky'] as const) {
      expect(newChargeStatus(method)).toBe('succeeded');
    }
  });
});
