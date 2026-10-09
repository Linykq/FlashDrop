import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { type DependencyCheck, failedChecks, type Logger } from '@flashdrop/config';
import {
  HealthResponse,
  PSP_IDEMPOTENCY_KEY_HEADER,
  PspChargeList,
  PspChargeRequest,
  PspChargeResponse,
  PspChargesQuery,
  PspCloseResponse,
  PspIdempotencyHeaders,
  PspLedgerResponse,
  PspReferenceParams,
} from '@flashdrop/contracts';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
  type onRequestAsyncHookHandler,
  type RawServerDefault,
} from 'fastify';
import {
  handleError,
  handleNotFound,
  PspError,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from './http';
import type { Ledger } from './ledger';
import { METRICS_PATH, metricsRoute } from './metrics';
import { planCharge, planClose, type Simulation } from './simulation';

export interface AppOptions {
  readonly logger: Logger;
  /** `PSP_API_KEY`: every `/v1/*` call must carry `Authorization: Bearer <key>`. */
  readonly apiKey: string;
  readonly ledger: Ledger;
  readonly simulation: Simulation;
  /** Checked by `GET /health`, by name. */
  readonly checks: Readonly<Record<string, DependencyCheck>>;
}

export type PspApp = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/** Polled by machines every few seconds (Compose's probes, Prometheus), so their requests are not logged. */
const QUIET_ROUTES = new Set(['/health', '/health/live', METRICS_PATH]);

/** Request bodies are a few dozen bytes. */
const BODY_LIMIT_BYTES = 16 * 1024;

/**
 * The simulated PSP (design §6.5) without listening, so tests can `inject()` or listen on port 0. Every
 * charge and close first waits its simulated latency outside any transaction, so slowness holds neither a
 * Postgres connection nor a reference lock; the ledger then decides inside one short transaction.
 */
export async function buildApp({ logger, apiKey, ledger, simulation, checks }: AppOptions): Promise<PspApp> {
  const app: PspApp = Fastify<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: logger,
    logController: new LogController({
      disableRequestLogging: (request) => QUIET_ROUTES.has(request.routeOptions.url ?? ''),
    }),
    bodyLimit: BODY_LIMIT_BYTES,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(handleError);
  app.setNotFoundHandler(handleNotFound);
  acceptEmptyJsonBodies(app);

  const withheld = withheldAnswers(simulation.hangMs);
  // Before the server waits for in-flight requests, which a withheld answer would hold up for hangMs.
  app.addHook('preClose', async () => withheld.destroyAll());

  // The API proper sits behind the key; the probes and /metrics stay open to the Compose network.
  await app.register(async (api: PspApp) => {
    api.addHook('onRequest', bearerGuard(apiKey));
    v1Routes(api, { ledger, simulation, withheld });
  });

  app.get('/health/live', { schema: { response: { 200: HealthResponse } } }, async () => ({
    status: 'ok' as const,
    checks: {},
  }));

  app.get('/health', { schema: { response: { 200: HealthResponse } } }, async (request) => {
    const failed = await failedChecks(checks, request.log);
    if (failed.length > 0) throw new PspError(503, 'unavailable', `${failed.join(', ')} unavailable`);
    return {
      status: 'ok' as const,
      checks: Object.fromEntries(Object.keys(checks).map((name) => [name, 'ok' as const])),
    };
  });

  metricsRoute(app);

  return app;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * 401 `unauthorized` unless the request carries `Authorization: Bearer <apiKey>`. Compared in constant
 * time over equal-length digests, so the answer's timing says nothing about how much of a guess matched.
 */
function bearerGuard(apiKey: string): onRequestAsyncHookHandler {
  const expected = digest(`Bearer ${apiKey}`);
  return async (request) => {
    const given = request.headers.authorization;
    if (given === undefined || !timingSafeEqual(digest(given), expected)) {
      throw new PspError(401, 'unauthorized', 'A valid API key is required');
    }
  };
}

interface V1Deps {
  readonly ledger: Ledger;
  readonly simulation: Simulation;
  readonly withheld: WithheldAnswers;
}

/** Charges, closes and the ledger reads: the PSP's API, every route behind the key. */
function v1Routes(app: PspApp, { ledger, simulation, withheld }: V1Deps): void {
  app.post(
    '/v1/charges',
    {
      schema: {
        headers: PspIdempotencyHeaders,
        body: PspChargeRequest,
        response: { 200: PspChargeResponse },
      },
    },
    async (request, reply) => {
      const command = { ...request.body, idempotencyKey: request.headers[PSP_IDEMPOTENCY_KEY_HEADER] };
      // References are order ids in FlashDrop: one grep follows an order end to end (§12).
      const log = request.log.child({ orderId: command.reference, idempotencyKey: command.idempotencyKey });
      const plan = planCharge(command.paymentMethod, simulation);
      await simulation.sleep(plan.delayMs);
      if (plan.failBeforeRecording) throw simulatedOutage(log);

      const result = await ledger.charge(command);
      if (result.kind === 'key_reused') {
        throw new PspError(422, 'idempotency_key_reused', 'Idempotency-Key was used for a different request');
      }
      const { response } = result;
      log.info({ result: result.kind, status: response.status }, 'charge');
      if (result.kind === 'created' && response.status === 'succeeded' && plan.withholdSuccess) {
        log.info({ chargeId: response.id }, 'charge recorded, answer withheld (timeout after success)');
        return withheld.add(request, reply);
      }
      if (result.kind === 'replayed') reply.header('idempotent-replayed', 'true');
      return response;
    },
  );

  // Idempotent by reference: a reference closes once, and its refunds are fixed from then on, so every
  // replay reads the same answer from the ledger. The key is required like on every POST, and logged.
  app.post(
    '/v1/references/:reference/close',
    {
      schema: {
        params: PspReferenceParams,
        headers: PspIdempotencyHeaders,
        response: { 200: PspCloseResponse },
      },
    },
    async (request) => {
      const { reference } = request.params;
      const log = request.log.child({
        orderId: reference,
        idempotencyKey: request.headers[PSP_IDEMPOTENCY_KEY_HEADER],
      });
      const plan = planClose(simulation);
      await simulation.sleep(plan.delayMs);
      if (plan.failBeforeRecording) throw simulatedOutage(log);

      const refunds = await ledger.close(reference);
      const [refund] = refunds;
      if (refunds.length > 1) {
        // INV-4 is broken for this reference: the caller charged it under two keys. All were refunded.
        log.warn({ refunds }, 'reference held several succeeded charges');
      }
      log.info({ refundedChargeId: refund?.chargeId }, 'reference closed');
      return refund === undefined
        ? {}
        : { refundedChargeId: refund.chargeId, amountCents: refund.amountCents };
    },
  );

  app.get(
    '/v1/charges',
    { schema: { querystring: PspChargesQuery, response: { 200: PspChargeList } } },
    async (request) => ({
      charges: await ledger.chargesFor(request.query.reference),
    }),
  );

  app.get('/v1/admin/ledger', { schema: { response: { 200: PspLedgerResponse } } }, () => ledger.summary());
}

function simulatedOutage(log: FastifyBaseLogger): PspError {
  log.info('simulated PSP error, nothing recorded');
  return new PspError(503, 'unavailable', 'Simulated PSP error, nothing was recorded; retry');
}

/**
 * Answers withheld after their charge committed. The connection stays open and silent until the caller
 * gives up (its timeout: the unknown outcome under test) or `hangMs` passes, when the socket is destroyed.
 */
interface WithheldAnswers {
  add(request: FastifyRequest, reply: FastifyReply): FastifyReply;
  destroyAll(): void;
}

function withheldAnswers(hangMs: number): WithheldAnswers {
  const sockets = new Set<Socket>();
  return {
    add(request: FastifyRequest, reply: FastifyReply): FastifyReply {
      reply.hijack();
      const { socket } = request.raw;
      sockets.add(socket);
      const timer = setTimeout(() => socket.destroy(), hangMs);
      socket.once('close', () => {
        clearTimeout(timer);
        sockets.delete(socket);
      });
      return reply;
    },
    destroyAll(): void {
      for (const socket of sockets) socket.destroy();
    },
  };
}

/**
 * A close has no body, and a client that still sends `Content-Type: application/json` must not get 400
 * for it (Fastify's default parser refuses an empty JSON body). Non-empty bodies keep Fastify's parser,
 * with its prototype-poisoning protection.
 */
function acceptEmptyJsonBodies(app: PspApp): void {
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    // parseAs 'string' always passes a string; the parser type admits both forms.
    const text = body.toString();
    if (text === '') done(null, undefined);
    else parseJson(request, text, done);
  });
}
