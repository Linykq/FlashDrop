import { setTimeout as delay } from 'node:timers/promises';
import type { PaymentMethod } from '@flashdrop/domain';

/*
 * How the mock misbehaves (design §6.5, §15). Every random draw happens here, behind an injectable
 * `random`, so the tests pin each failure mode instead of sampling it.
 *
 * What a failure leaves behind is the point of each mode:
 *   - a 503 (PSP_ERROR_RATE, half of pm_flaky's failures) records nothing: a clean transient error;
 *   - a withheld success (PSP_TIMEOUT_AFTER_SUCCESS_RATE, the other half) records the charge and never
 *     answers: the caller sees a timeout, an unknown outcome, and must retry with the same key;
 *   - a decline is a function of the method alone, so a replay can rebuild it from the ledger row, which
 *     stores no decline code.
 */

/** The decline code of every `pm_decline` charge. */
export const CARD_DECLINED = 'card_declined';

export interface SimulationConfig {
  /** `PSP_LATENCY_MS`: each charge and close first waits a uniformly random time within the range. */
  readonly latency: { readonly minMs: number; readonly maxMs: number };
  /** `PSP_ERROR_RATE`: a charge or close answers 503 after its latency, having recorded nothing. */
  readonly errorRate: number;
  /** `PSP_TIMEOUT_AFTER_SUCCESS_RATE`: a charge that succeeds is recorded, then never answered. */
  readonly timeoutAfterSuccessRate: number;
}

export interface Simulation extends SimulationConfig {
  /** Uniform in [0, 1), like `Math.random`. */
  readonly random: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** How long a withheld answer keeps its connection open before the socket is destroyed. */
  readonly hangMs: number;
}

/**
 * pm_slow's extra processing time. Slow enough to show the "Processing" state and the payment consumer's
 * in-batch concurrency, but under its 5 s client timeout (§6.5) even at the top of the default latency
 * range: slowness alone never becomes an unknown outcome, which would retry until the order expired.
 */
export const SLOW_METHOD_DELAY_MS = 2_500;

/** pm_flaky: the probability of a 503 per attempt, and again of a withheld success. */
export const FLAKY_FAILURE_RATE = 0.25;

/** Far beyond any sane client timeout, so the caller gives up first, as with a real lost response. */
export const DEFAULT_HANG_MS = 30_000;

export function createSimulation(
  config: SimulationConfig,
  overrides: Partial<Omit<Simulation, keyof SimulationConfig>> = {},
): Simulation {
  return { ...config, random: Math.random, sleep: (ms) => delay(ms), hangMs: DEFAULT_HANG_MS, ...overrides };
}

/** What one attempt will do, decided before it touches the ledger. */
export interface AttemptPlan {
  readonly delayMs: number;
  /** Answer 503 after the delay, recording nothing. */
  readonly failBeforeRecording: boolean;
  /**
   * When this attempt creates a succeeded charge: commit it, then withhold the answer. Never applied to a
   * replay, because the retry after an unknown outcome must get the recorded result, or the order could
   * never be paid.
   */
  readonly withholdSuccess: boolean;
}

type Draws = Pick<Simulation, 'latency' | 'errorRate' | 'timeoutAfterSuccessRate' | 'random'>;

export function planCharge(method: PaymentMethod, sim: Draws): AttemptPlan {
  const flaky = method === 'pm_flaky' ? sim.random() : 1;
  return {
    delayMs: latencyMs(sim) + (method === 'pm_slow' ? SLOW_METHOD_DELAY_MS : 0),
    failBeforeRecording: sim.random() < sim.errorRate || flaky < FLAKY_FAILURE_RATE,
    withholdSuccess:
      sim.random() < sim.timeoutAfterSuccessRate ||
      (flaky >= FLAKY_FAILURE_RATE && flaky < 2 * FLAKY_FAILURE_RATE),
  };
}

export function planClose(sim: Draws): AttemptPlan {
  return {
    delayMs: latencyMs(sim),
    failBeforeRecording: sim.random() < sim.errorRate,
    withholdSuccess: false,
  };
}

/** The status a new charge is recorded with. Only `pm_decline` declines, always with `card_declined`. */
export function newChargeStatus(method: PaymentMethod): 'succeeded' | 'declined' {
  return method === 'pm_decline' ? 'declined' : 'succeeded';
}

function latencyMs({ latency: { minMs, maxMs }, random }: Draws): number {
  return minMs + Math.floor(random() * (maxMs - minMs + 1));
}
