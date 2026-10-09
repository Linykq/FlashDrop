-- The reserve transaction as one server-side function (design §5.2 "Hot row", escalation step 1).
--
-- M2 measured the cost of running it from the api statement by statement: every winner holds the hot
-- drop_inventory row from its UPDATE until the api's COMMIT arrives, and under a burst that round trip waits
-- behind a saturated event loop, so the row admitted about 95 transactions/s instead of 800. Called as ONE
-- statement outside an explicit transaction, fd_record_reservation runs in the implicit transaction of that
-- statement: Postgres commits it as soon as the function returns, in the same round trip, so the row lock is
-- held for the UPDATE, the rest of the function and the commit flush, and never across the network.
--
-- The steps are separate functions so that the api's one call and the tests that hold a reserve transaction
-- open between steps (the generation fence, rebuild snapshots) run the same statements. They follow the
-- global lock order (§3): orders row -> user_drop_quota row -> drop_inventory row, always last. A transaction
-- holding the hot row never waits on anything else, so it cannot be part of a deadlock.
--
-- Refusals (LIMIT, and STALE_GEN, NOT_LIVE or SOLD_OUT from the stock) raise SQLSTATE FD001 with the reason as
-- DETAIL. The error aborts the implicit transaction, so the order, the quota claim and the outbox row roll
-- back with it. An EXCEPTION block that returned the reason instead would open a subtransaction in every
-- reservation, the winners included; raising costs only the refusals, which happen only when Redis was wrong.

-- Inserts the order as RESERVED with the drop's product and price, expires_at = now() + hold_seconds. No row
-- when the rid already exists (a replay; a same-key insert still in flight holds the primary key, so this
-- waits for it, §4.5) or the drop does not exist (which Lua never admits).
-- ON CONFLICT names no target on purpose: a same-key request collides on two unique indexes, the primary key
-- and (user_id, drop_id, idempotency_key), which encode the same identity (rid = uuidv5 of that triple). With
-- ON CONFLICT (id) two concurrent same-key inserts could meet on the other index first and fail with 23505
-- instead of replaying (seen under a 50-request storm in M2).
CREATE FUNCTION fd_insert_reserved_order(p_id uuid, p_user_id uuid, p_drop_id uuid, p_qty int,
                                         p_idempotency_key text, p_request_hash bytea)
RETURNS SETOF orders LANGUAGE plpgsql AS $$
DECLARE
  v_order orders;
BEGIN
  INSERT INTO orders (id, user_id, drop_id, product_id, qty, unit_price_cents, currency, status,
                      idempotency_key, request_hash, expires_at)
  SELECT p_id, p_user_id, d.id, d.product_id, p_qty, d.price_cents, d.currency, 'RESERVED',
         p_idempotency_key, p_request_hash, now() + make_interval(secs => d.hold_seconds)
  FROM drops d WHERE d.id = p_drop_id
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_order;
  IF FOUND THEN
    RETURN NEXT v_order;
  END IF;
END
$$;
--> statement-breakpoint
-- Adds p_qty to the user's quota for the drop unless that would pass the limit (within_limit, INV-3). The
-- first claim copies the drop's per-user limit into limit_qty; armed drops never change it, so the copy cannot
-- go stale. The upsert locks the quota row, so concurrent claims of one user, from any number of tabs and
-- keys, serialize on it and each sees the committed total. False: the limit would be passed.
CREATE FUNCTION fd_claim_quota(p_user_id uuid, p_drop_id uuid, p_qty int)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO user_drop_quota (user_id, drop_id, claimed, limit_qty)
  SELECT p_user_id, d.id, p_qty, d.per_user_limit FROM drops d
  WHERE d.id = p_drop_id AND p_qty <= d.per_user_limit
  ON CONFLICT (user_id, drop_id) DO UPDATE SET claimed = user_drop_quota.claimed + EXCLUDED.claimed
    WHERE user_drop_quota.claimed + EXCLUDED.claimed <= user_drop_quota.limit_qty;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
-- Takes p_qty units of the drop: the hot row, the last statement of the reserve transaction. One conditional
-- UPDATE carries three guarantees: the generation fence (a rebuild since Lua admitted the request makes it
-- fail, §4.7), the stock backstop (INV-1, whatever Redis said) and the window backstop (no order outside
-- SCHEDULED/LIVE and [starts_at, ends_at), whatever the Redis status). The join reads drops through MVCC and
-- locks nothing there. Nothing that waits may follow it in the transaction.
-- On 0 rows it re-reads and classifies, in this order: STALE_GEN (retry with the same key), NOT_LIVE,
-- SOLD_OUT. The re-read may see later commits than the UPDATE did; any answer it gives is still a refusal of
-- this transaction, and SOLD_OUT is the default.
CREATE FUNCTION fd_take_stock(p_drop_id uuid, p_qty int, p_gen int)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_gen int;
  v_open boolean;
BEGIN
  UPDATE drop_inventory di SET reserved = di.reserved + p_qty, updated_at = now()
  FROM drops d
  WHERE di.drop_id = p_drop_id AND d.id = di.drop_id
    AND di.redis_gen = p_gen
    AND di.total - di.sold - di.reserved >= p_qty
    AND d.status IN ('SCHEDULED', 'LIVE') AND now() >= d.starts_at AND now() < d.ends_at;
  IF FOUND THEN
    RETURN 'OK';
  END IF;

  SELECT di.redis_gen, d.status IN ('SCHEDULED', 'LIVE') AND now() >= d.starts_at AND now() < d.ends_at
  INTO v_gen, v_open
  FROM drop_inventory di JOIN drops d ON d.id = di.drop_id
  WHERE di.drop_id = p_drop_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fd_take_stock: drop % has no inventory', p_drop_id;
  END IF;
  IF v_gen <> p_gen THEN
    RETURN 'STALE_GEN';
  END IF;
  IF NOT v_open THEN
    RETURN 'NOT_LIVE';
  END IF;
  RETURN 'SOLD_OUT';
END
$$;
--> statement-breakpoint
-- The reserve transaction (§5.2) for a hold Lua granted under generation p_gen: the order, the quota, the
-- order.reserved outbox row, then the stock. Call it as a statement of its own, never inside an explicit
-- transaction, or the hot row stays locked until that transaction's COMMIT arrives. Sends no NOTIFY (§5.4).
--
-- One row: committed, with the product summary of the 201 answer. No row: the rid already has an order, which
-- the caller reads and replays. SQLSTATE FD001: refused, the reason in DETAIL, nothing written.
--
-- The event is the orders.v1 order.reserved envelope of packages/contracts (OrderEvent, schemaVersion 1),
-- with the uuidv7 event id and the optional trace id from the caller; it is built here because its product,
-- price and times are Postgres's. occurredAt and expiresAt print in the form of JavaScript's toISOString(),
-- milliseconds truncated as a JavaScript Date truncates the microseconds Postgres stores. The integration
-- tests pin this envelope to the Zod schema; a breaking change to it is a new topic and a new function.
CREATE FUNCTION fd_record_reservation(p_id uuid, p_user_id uuid, p_drop_id uuid, p_qty int,
                                      p_idempotency_key text, p_request_hash bytea, p_gen int,
                                      p_event_id uuid, p_trace_id text)
RETURNS TABLE (reserved_order orders, product_slug text, product_title text, product_image_keys text[])
LANGUAGE plpgsql AS $$
DECLARE
  v_stock text;
BEGIN
  SELECT * INTO reserved_order
  FROM fd_insert_reserved_order(p_id, p_user_id, p_drop_id, p_qty, p_idempotency_key, p_request_hash);
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT p.slug, p.title, p.image_keys INTO product_slug, product_title, product_image_keys
  FROM products p WHERE p.id = reserved_order.product_id;

  IF NOT fd_claim_quota(p_user_id, p_drop_id, p_qty) THEN
    RAISE EXCEPTION 'reservation refused: LIMIT' USING ERRCODE = 'FD001', DETAIL = 'LIMIT';
  END IF;

  INSERT INTO outbox (event_id, topic, partition_key, event_type, payload, headers)
  VALUES (
    p_event_id, 'orders.v1', reserved_order.product_id::text, 'order.reserved',
    jsonb_build_object(
      'eventId', p_event_id,
      'schemaVersion', 1,
      'type', 'order.reserved',
      'occurredAt', to_char(reserved_order.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'orderId', reserved_order.id,
      'orderVersion', reserved_order.version,
      'productId', reserved_order.product_id,
      'dropId', reserved_order.drop_id,
      'userId', reserved_order.user_id,
      'data', jsonb_build_object(
        'qty', reserved_order.qty,
        'unitPriceCents', reserved_order.unit_price_cents,
        'expiresAt', to_char(reserved_order.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      || CASE WHEN p_trace_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('traceId', p_trace_id) END,
    CASE WHEN p_trace_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('trace-id', p_trace_id) END);

  v_stock := fd_take_stock(p_drop_id, p_qty, p_gen);
  IF v_stock <> 'OK' THEN
    RAISE EXCEPTION 'reservation refused: %', v_stock USING ERRCODE = 'FD001', DETAIL = v_stock;
  END IF;
  RETURN NEXT;
END
$$;
