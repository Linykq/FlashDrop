import fastifyRateLimit, { type FastifyRateLimitStore, normalizeIP } from '@fastify/rate-limit';
import { DomainError } from '@flashdrop/domain';
import { type RateLimitHit, rateLimitKey } from '@flashdrop/inventory';
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { Api } from './api';

/*
 * Rate limits (design §11): `@fastify/rate-limit` with a custom store on node-redis. The plugin's own Redis
 * store needs ioredis (`defineCommand`), and the project runs one Redis client. Each hit is one call of the
 * `fd_rl_hit` Function: INCR plus PEXPIRE on the first hit of a fixed window, so the counter and its expiry
 * are set atomically and every api replica shares the same windows.
 */

/** One hit on the fixed-window counter `key`: `fdRateLimitHit(redis, ...)`, or an in-memory fake in tests. */
export type RateLimitCounter = (key: string, windowMs: number) => Promise<RateLimitHit>;

/**
 * The plugin's `store` option. Keys arrive complete (`rateLimitKey(route, subject)` from the limiter's key
 * generator), so a child store needs nothing from its route and shares the counter.
 */
export function redisRateLimitStore(counter: RateLimitCounter) {
  return class RedisRateLimitStore implements FastifyRateLimitStore {
    incr(
      key: string,
      callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
      timeWindow: number,
    ): void {
      counter(key, timeWindow).then(
        ({ count, ttlMs }) => callback(null, { current: count, ttl: ttlMs }),
        (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
      );
    }

    child(): RedisRateLimitStore {
      return this;
    }
  };
}

/** 429 `RATE_LIMITED` with `Retry-After`: the seconds until the caller's window resets. */
export class RateLimitedError extends DomainError {
  override name = 'RateLimitedError';
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('RATE_LIMITED', 'Too many requests, slow down');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimitSettings {
  readonly counter: RateLimitCounter;
  /** `RATE_LIMIT_USER_PER_SEC`. */
  readonly userPerSecond: number;
  /** `RATE_LIMIT_IP_PER_SEC`. */
  readonly ipPerSecond: number;
}

export interface ReservationLimits {
  /** Per client IP, for every caller. */
  readonly byIp: onRequestAsyncHookHandler;
  /** Per signed-in user; runs after the session check, so anonymous callers never reach it. */
  readonly byUser: onRequestAsyncHookHandler;
}

const WINDOW_MS = 1_000;

/**
 * Registers the plugin (no global limit) and returns the reservation limits. Two limits on one route need
 * `createRateLimit`: the plugin's per-route hook runs only once per request, whatever the number of limits.
 * A Redis failure propagates (`skipOnError` stays off): the reserve itself needs Redis, so the request
 * answers 503 `RETRY` either way.
 */
export async function registerRateLimits(app: Api, settings: RateLimitSettings): Promise<ReservationLimits> {
  await app.register(fastifyRateLimit, { global: false, store: redisRateLimitStore(settings.counter) });

  const limiter = (route: string, max: number, subject: (request: FastifyRequest) => string) => {
    const check = app.createRateLimit({
      max,
      timeWindow: WINDOW_MS,
      keyGenerator: (request) => rateLimitKey(route, subject(request)),
    });
    const hook: onRequestAsyncHookHandler = async (request) => {
      const result = await check(request);
      if (!result.isAllowed && result.isExceeded) {
        throw new RateLimitedError(Math.max(1, result.ttlInSeconds));
      }
    };
    return hook;
  };

  return {
    // trustProxy makes request.ip the client behind Caddy; IPv6 clients are limited per /64, like the plugin.
    byIp: limiter('reserve-ip', settings.ipPerSecond, (request) => normalizeIP(request.ip)),
    byUser: limiter('reserve-user', settings.userPerSecond, (request) => request.session?.sub ?? 'anonymous'),
  };
}
