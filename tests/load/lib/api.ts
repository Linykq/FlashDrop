import http from 'k6/http';
import { API, BASE_URL, ORIGIN, TEST_SECRET } from './config.ts';
import type { ReserveAnswer } from './verdict.ts';

/*
 * The api as k6 sees it (design §5.1), with the shapes of `@flashdrop/contracts` checked by hand: k6 runs
 * no Node modules, so Zod is not available here. Every mutating request carries an allowed `Origin`
 * (§11); the test routes also carry `x-test-secret`.
 */

const JSON_HEADERS = { 'content-type': 'application/json', origin: ORIGIN };
const TEST_HEADERS = { ...JSON_HEADERS, 'x-test-secret': TEST_SECRET };
/** Sessions per `POST /test/sessions`, so no single request signs thousands of tokens. */
const SESSIONS_PER_REQUEST = 1_000;

export interface Session {
  readonly userId: string;
  /** The `fd_session` cookie value. */
  readonly token: string;
}

export interface TestDrop {
  readonly dropId: string;
  readonly productSlug: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface Stock {
  readonly avail: number;
  readonly held: number;
  readonly sold: number;
  readonly status: string;
  readonly gen: number;
  readonly seq: number;
}

/** What a reserve request is: whose session, which key, how many units. */
export interface ReserveRequest {
  readonly token: string;
  readonly idempotencyKey: string;
  readonly qty: number;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function body(response: http.Response): unknown {
  try {
    return typeof response.body === 'string' ? JSON.parse(response.body) : undefined;
  } catch {
    return undefined;
  }
}

/** Fails setup with the fix in the message rather than letting every iteration fail on its own. */
function expectStatus(response: http.Response, expected: number, what: string): unknown {
  if (response.status === expected) return body(response);
  const hint =
    response.status === 0
      ? `no answer from ${BASE_URL}: is the stack up (pnpm stack:up)?`
      : response.status === 404
        ? 'not found: start the stack with ENABLE_TEST_ROUTES=true'
        : response.status === 403
          ? `forbidden: check TEST_SECRET and that ${ORIGIN} is in WS_ALLOWED_ORIGINS`
          : String(response.body).slice(0, 300);
  throw new Error(`${what} answered ${response.status}: ${hint}`);
}

/** `POST /test/sessions`: `count` fresh buyers with a signed session each. */
export function mintSessions(count: number): Session[] {
  const sessions: Session[] = [];
  for (let left = count; left > 0; left -= SESSIONS_PER_REQUEST) {
    const response = http.post(
      `${API}/test/sessions`,
      JSON.stringify({ count: Math.min(SESSIONS_PER_REQUEST, left) }),
      { headers: TEST_HEADERS, tags: { name: 'test-sessions' }, timeout: '60s' },
    );
    const answer = expectStatus(response, 200, 'POST /test/sessions');
    const minted = isRecord(answer) && Array.isArray(answer.sessions) ? answer.sessions : [];
    for (const session of minted) {
      if (!isRecord(session) || typeof session.userId !== 'string' || typeof session.token !== 'string') {
        throw new Error(`POST /test/sessions answered an unexpected shape: ${JSON.stringify(session)}`);
      }
      sessions.push({ userId: session.userId, token: session.token });
    }
  }
  if (sessions.length !== count) throw new Error(`asked for ${count} sessions, got ${sessions.length}`);
  return sessions;
}

/** `POST /test/drops`: a fresh product and drop, armed (its Redis state built) and open from now. */
export function createTestDrop(settings: {
  readonly stock: number;
  readonly perUserLimit: number;
  readonly holdSeconds: number;
  readonly durationSeconds: number;
}): TestDrop {
  const response = http.post(`${API}/test/drops`, JSON.stringify({ ...settings, paymentSeconds: 300 }), {
    headers: TEST_HEADERS,
    tags: { name: 'test-drops' },
    timeout: '30s',
  });
  const drop = expectStatus(response, 201, 'POST /test/drops');
  if (!isRecord(drop) || typeof drop.dropId !== 'string' || typeof drop.productSlug !== 'string') {
    throw new Error(`POST /test/drops answered an unexpected shape: ${JSON.stringify(drop)}`);
  }
  return {
    dropId: drop.dropId,
    productSlug: drop.productSlug,
    startsAt: String(drop.startsAt),
    endsAt: String(drop.endsAt),
  };
}

/** `GET /drops/:dropId/stock`, the level the storefront shows (from Redis since M2). */
export function readStock(dropId: string): Stock {
  const response = http.get(`${API}/drops/${dropId}/stock`, { tags: { name: 'stock' }, timeout: '10s' });
  const stock = expectStatus(response, 200, `GET /drops/${dropId}/stock`);
  if (!isRecord(stock) || typeof stock.avail !== 'number' || typeof stock.held !== 'number') {
    throw new Error(`GET stock answered an unexpected shape: ${JSON.stringify(stock)}`);
  }
  return {
    avail: stock.avail,
    held: stock.held,
    sold: Number(stock.sold),
    status: String(stock.status),
    gen: Number(stock.gen),
    seq: Number(stock.seq),
  };
}

/** A 409 is an answer, not a failure: `http_req_failed` counts only what no client should ever see. */
const RESERVE_EXPECTED = http.expectedStatuses(200, 201, 409);

function reserveRequest(dropId: string, request: ReserveRequest) {
  return {
    method: 'POST',
    url: `${API}/drops/${dropId}/reservations`,
    body: JSON.stringify({ qty: request.qty }),
    params: {
      headers: { ...JSON_HEADERS, 'idempotency-key': request.idempotencyKey },
      cookies: { fd_session: request.token },
      tags: { name: 'reserve' },
      timeout: '10s',
      responseCallback: RESERVE_EXPECTED,
    },
  };
}

/** `POST /drops/:dropId/reservations` with the request's own key, session and body. */
export function reserve(dropId: string, request: ReserveRequest): http.Response {
  const { url, body, params } = reserveRequest(dropId, request);
  return http.post(url, body, params);
}

/**
 * `copies` identical reserves in flight at once (`http.batch`), as a double click sends them: the same-key
 * race of §4.5, where the later request waits for the first one's commit and replays it. The answers come
 * back in request order.
 */
export function reserveCopies(dropId: string, request: ReserveRequest, copies: number): http.Response[] {
  if (copies === 1) return [reserve(dropId, request)];
  return http.batch(Array.from({ length: copies }, () => reserveRequest(dropId, request)));
}

/** The order of a 201/200 `OrderResponse`; undefined for any other shape. */
function orderOf(response: http.Response): ReserveAnswer['order'] {
  const answer = body(response);
  const order = isRecord(answer) ? answer.order : undefined;
  if (!isRecord(order) || typeof order.id !== 'string' || typeof order.status !== 'string') return undefined;
  return { id: order.id, status: order.status, qty: Number(order.qty) };
}

/** The stable `code` of a problem-details answer (`SOLD_OUT`, `RETRY`, ...). */
export function problemCode(response: http.Response): string | undefined {
  const answer = body(response);
  return isRecord(answer) && typeof answer.code === 'string' ? answer.code : undefined;
}

/** k6 canonicalizes header names (`Idempotency-Replayed`). */
export function header(response: http.Response, name: string): string | undefined {
  const value = response.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** What a reserve answer says, in the shape `verdict.ts` judges. */
export function answerOf(response: http.Response): ReserveAnswer {
  return {
    status: response.status,
    order: orderOf(response),
    replayed: header(response, 'Idempotency-Replayed') === 'true',
    code: problemCode(response),
  };
}
