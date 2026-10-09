import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { normalizeIP } from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { WS_HEARTBEAT, WS_MAX_PAYLOAD_BYTES, WS_PATH } from '@flashdrop/contracts';
import { DomainError } from '@flashdrop/domain';
import { createSubscriber, type FlashdropRedis, readStock } from '@flashdrop/inventory';
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import type { Api } from '../http/api';
import { RateLimitedError, rateLimitHook } from '../http/rate-limit';
import type { RoomReader, TopicIdLookup } from '../services/rooms';
import { principalOf } from './access';
import type { PubSub } from './channels';
import { createTopicDirectory } from './directory';
import { createGateway, type DashboardReader, type Gateway, type GatewayLimits } from './gateway';
import { createRedisViewerStore } from './viewers';

/*
 * The WebSocket gateway as a Fastify plugin (design §7), mounted at `/ws` when `API_ROLES` contains `ws`.
 * The upgrade runs through the app's hooks like any request, so `request.session` is the verified
 * `fd_session` cookie; this route adds the Origin check, which the CSRF guard skips for GETs, and the
 * per-address limits (§11): upgrades per second through the shared `fd_rl_hit` counter, and open sockets on
 * this instance. Both answer 429 before the upgrade; the client backs off and polls meanwhile.
 */

export interface RealtimeOptions {
  /** The command client: stock snapshots and viewer counts. The gateway's subscriber is its duplicate. */
  readonly redis: FlashdropRedis;
  readonly rooms: RoomReader;
  /** Which drop and room ids exist: topics naming anything else are refused. */
  readonly topicIds: TopicIdLookup;
  /** The dashboard projection's totals (§9), for `dash:` snapshots. */
  readonly dashboard?: DashboardReader;
  /** Defaults to `<hostname>-<random>`: unique per process, readable in logs and `hello`. */
  readonly instanceId?: string;
  /** `WS_MAX_SOCKETS_PER_IP`: open sockets per client address on one instance. */
  readonly maxSocketsPerAddress?: number;
  /** Tests shorten the timers and buffers. */
  readonly limits?: Partial<GatewayLimits>;
}

export interface GatewayPluginOptions extends RealtimeOptions {
  /** `WS_ALLOWED_ORIGINS`. */
  readonly allowedOrigins: readonly string[];
  /** `RATE_LIMIT_IP_PER_SEC`: upgrades per second per client address, the same budget as reservations. */
  readonly upgradesPerSecond: number;
}

/** Without `WS_MAX_SOCKETS_PER_IP`: above one k6 host at the laptop profile (1,000 sockets per instance). */
export const DEFAULT_MAX_SOCKETS_PER_ADDRESS = 2_000;

/** `?beat=1` opts the socket in to `beat` frames (`WS_HEARTBEAT`); other parameters are ignored. */
const UpgradeQuery = z.object({ [WS_HEARTBEAT.query]: z.literal('1').optional() });

/**
 * Cross-site WebSocket hijacking (§7, §11): a page on another site can open a socket to us, and the browser
 * attaches the session cookie. Browsers always send `Origin` on the handshake, so only listed origins pass;
 * non-browser clients (k6) send an allowed one explicitly.
 */
function originCheck(allowedOrigins: readonly string[]): onRequestAsyncHookHandler {
  const allowed = new Set(allowedOrigins);
  return async (request) => {
    const { origin } = request.headers;
    if (origin === undefined || !allowed.has(origin))
      throw new DomainError('FORBIDDEN', 'Origin not allowed');
  };
}

/**
 * The client's address: trustProxy makes `request.ip` the client behind Caddy; IPv6 clients count per /64,
 * as the reservation limits do, so rotating addresses inside one allocation gains nothing.
 */
const addressOf = (request: FastifyRequest) => normalizeIP(request.ip);

/** Refuses an upgrade from an address that already holds `max` sockets here. */
function socketCap(gateway: Gateway, max: number): onRequestAsyncHookHandler {
  return async (request) => {
    if (gateway.socketsFrom(addressOf(request)) >= max) throw new RateLimitedError(1);
  };
}

function defaultInstanceId(): string {
  return `${hostname().slice(0, 48)}-${randomBytes(3).toString('hex')}`;
}

export async function websocketGateway(app: Api, options: GatewayPluginOptions): Promise<void> {
  const instanceId = options.instanceId ?? defaultInstanceId();
  const logger = app.log.child({ component: 'ws-gateway', instanceId });
  const { redis } = options;

  const subscriber = createSubscriber(redis, {
    name: `api-sub:${instanceId}`,
    logger,
    // Fires only after a reconnect, so never before `gateway` below exists.
    onResubscribed: () => {
      gateway.resnapshot().catch((err: unknown) => logger.error({ err }, 're-snapshot failed'));
    },
  });
  await subscriber.connect();
  const pubsub: PubSub = {
    subscribe: (channel, listener) => subscriber.subscribe(channel, listener),
    unsubscribe: (channel, listener) => subscriber.unsubscribe(channel, listener),
  };
  const gateway = createGateway({
    instanceId,
    pubsub,
    sources: {
      stock: (dropId) => readStock(redis, dropId),
      rooms: options.rooms,
      ...(options.dashboard === undefined ? {} : { dashboard: options.dashboard }),
    },
    directory: createTopicDirectory({ lookup: options.topicIds, log: logger }),
    viewers: createRedisViewerStore(redis, instanceId),
    logger,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });

  await app.register(fastifyWebsocket, {
    options: { maxPayload: WS_MAX_PAYLOAD_BYTES },
    errorHandler(err, socket, request) {
      // Mostly clients vanishing mid-frame (ECONNRESET); the socket is unusable either way.
      request.log.warn({ err }, 'websocket error');
      socket.terminate();
    },
    // Replaces the plugin's own, which closes sockets without a code: 1001 tells clients to reconnect, and
    // the viewer fields go before the command client does.
    async preClose() {
      await gateway.close();
      await new Promise<void>((resolve) => app.websocketServer.close(() => resolve()));
    },
  });
  app.addHook('onClose', async () => {
    subscriber.destroy();
  });

  app.get(
    WS_PATH,
    {
      websocket: true,
      schema: { querystring: UpgradeQuery },
      onRequest: [
        originCheck(options.allowedOrigins),
        socketCap(gateway, options.maxSocketsPerAddress ?? DEFAULT_MAX_SOCKETS_PER_ADDRESS),
        rateLimitHook(app, {
          route: 'ws-upgrade',
          max: options.upgradesPerSecond,
          windowMs: 1_000,
          subject: addressOf,
        }),
      ],
    },
    (socket, request) => {
      gateway.attach(socket, principalOf(request.session), {
        address: addressOf(request),
        beats: request.query[WS_HEARTBEAT.query] === '1',
      });
    },
  );
  logger.info('websocket gateway ready');
}
