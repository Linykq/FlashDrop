import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fastifyCookie from '@fastify/cookie';
import type { ApiRole, Logger } from '@flashdrop/config';
import { SESSION_COOKIE } from '@flashdrop/config/constants';
import Fastify, { type FastifyBaseLogger, LogController, type RawServerDefault } from 'fastify';
import type { Api } from './http/api';
import { originGuard } from './http/origin';
import { handleError, handleNotFound } from './http/problem';
import { type RateLimitCounter, registerRateLimits } from './http/rate-limit';
import { createSessionCodec } from './http/session';
import { traceIdOf } from './http/trace';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from './http/zod';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { catalogRoutes } from './routes/catalog';
import { healthRoutes, PROBE_ROUTES } from './routes/health';
import { orderRoutes } from './routes/orders';
import { reservationRoutes } from './routes/reservations';
import { testRoutes } from './routes/testing';
import { uploadRoutes } from './routes/uploads';
import type { AdminDropService } from './services/admin-drops';
import type { CatalogStore } from './services/catalog';
import type { DependencyCheck } from './services/health';
import type { OrderReader } from './services/orders';
import type { ReservationService } from './services/reserve';
import type { StockReader } from './services/stock';
import type { TestRouteService } from './services/testing';
import type { UserStore } from './services/users';

export interface AppServices {
  readonly catalog: CatalogStore;
  readonly stock: StockReader;
  readonly users: UserStore;
  readonly reservations: ReservationService;
  readonly orders: OrderReader;
  readonly adminDrops: AdminDropService;
  /** The fixed-window counter behind the rate limits: the `fd_rl_hit` Function (§11). */
  readonly rateLimitCounter: RateLimitCounter;
  /** Dependencies the readiness probe checks, by name. */
  readonly checks: Readonly<Record<string, DependencyCheck>>;
}

/** `ENABLE_TEST_ROUTES=true`: the routes exist only then, and every call must carry the secret. */
export interface TestRoutesOptions {
  readonly secret: string;
  readonly service: TestRouteService;
}

export interface AppOptions {
  readonly logger: Logger;
  /** `API_ROLES`: `http` serves REST and uploads; `ws` is the WebSocket gateway from M5. */
  readonly roles: readonly ApiRole[];
  /** `WS_ALLOWED_ORIGINS`, also the allowlist for mutating requests (design §11). */
  readonly allowedOrigins: readonly string[];
  readonly sessionSecret: string;
  readonly uploadDir: string;
  readonly services: AppServices;
  /** Reservations per second: `RATE_LIMIT_USER_PER_SEC` and `RATE_LIMIT_IP_PER_SEC` (§11). */
  readonly rateLimits: { readonly userPerSecond: number; readonly ipPerSecond: number };
  /** Mounts `/api/v1/test/*` (§5.1, §13). Absent in production. */
  readonly testRoutes?: TestRoutesOptions;
  readonly now?: () => Date;
}

/** JSON bodies in FlashDrop are a few hundred bytes; the multipart listing upload (M8) sets its own limit. */
const BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Longer than Caddy's 2 min upstream keep-alive, so the api never closes an idle connection that Caddy is
 * about to reuse, which would fail that request with a 502.
 */
const KEEP_ALIVE_TIMEOUT_MS = 125_000;

/** Builds the api without listening, so tests drive it with `inject()`. */
export async function buildApp(options: AppOptions): Promise<Api> {
  const { services } = options;
  const roles = new Set(options.roles);

  const app = Fastify<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: options.logger,
    genReqId: () => randomUUID(),
    childLoggerFactory: (logger, bindings, childOptions, raw) =>
      logger.child({ ...bindings, traceId: traceIdOf(raw) }, childOptions),
    logController: new LogController({
      disableRequestLogging: (request) => PROBE_ROUTES.has(request.routeOptions.url ?? ''),
    }),
    // Forwarded headers are trusted only from Caddy and web: loopback in dev, the Compose network in the stack.
    trustProxy: ['loopback', 'uniquelocal'],
    bodyLimit: BODY_LIMIT_BYTES,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(handleError);
  app.setNotFoundHandler(handleNotFound);
  // JSON (and from M8 multipart) only: text/plain is a CORS "simple" type that a cross-site form can send.
  app.removeContentTypeParser('text/plain');

  app.decorateRequest('traceId', {
    getter() {
      return traceIdOf(this.raw);
    },
  });
  app.decorateRequest('session', null);
  // The cheap CSRF check first: a refused request costs no token verification.
  app.addHook('onRequest', originGuard(options.allowedOrigins));
  await app.register(fastifyCookie);
  const sessions = createSessionCodec(options.sessionSecret);
  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    request.session = token === undefined ? null : await sessions.verify(token);
  });
  const limits = await registerRateLimits(app, {
    counter: services.rateLimitCounter,
    ...options.rateLimits,
  });
  const now = options.now ?? (() => new Date());

  await app.register(
    async (api: Api) => {
      healthRoutes(api, services.checks);
      if (roles.has('http')) {
        authRoutes(api, { users: services.users, sessions });
        catalogRoutes(api, { catalog: services.catalog, stock: services.stock, now });
        reservationRoutes(api, { reservations: services.reservations, limits });
        orderRoutes(api, { orders: services.orders, now });
        adminRoutes(api, { adminDrops: services.adminDrops });
        if (options.testRoutes !== undefined) testRoutes(api, { ...options.testRoutes, sessions });
      }
    },
    { prefix: '/api/v1' },
  );
  if (roles.has('http')) uploadRoutes(app, options.uploadDir);
  // TODO(M5): mount the WebSocket gateway at /ws when roles has 'ws'.

  return app;
}
