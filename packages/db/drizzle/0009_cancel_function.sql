-- Cancel (design §4.4) as one server-side function, for the reason 0006 made the reserve transaction one.
--
-- A buyer's cancel runs in the api, the processes a burst saturates, and its last statement updates the
-- drop's hot drop_inventory row. Sent from the api statement by statement, the transaction holds that row
-- from its UPDATE until the api has read the answer and sent COMMIT, which under a burst waits behind a
-- saturated event loop: the M2 bottleneck (about 95 instead of 800 commits/s on the row) that 0006 removed
-- for reserves, and in a sale where many winners cancel (k6 ci: 20% of them, during the burst) every cancel
-- would hold up the reserves queued on the row. Called as ONE statement outside an explicit transaction,
-- fd_cancel_order commits in the round trip that runs it, so the row is held for its UPDATE and the commit
-- flush, never across the network.
--
-- No NOTIFY, unlike the cancel it replaces (§5.4): a commit with a queued notification takes the database-wide
-- notification lock and holds it through its flush, so every notifying commit runs one after another. A
-- cancel would wait there, behind the burst's checkout submits, with the hot row still locked. Its event
-- waits for the relay's 250 ms poll instead.
--
-- Lock order as everywhere (§3): the orders row, then the user's quota row, then drop_inventory, last.
--
-- p_from is the set of statuses the cancel may leave: both live statuses, or only RESERVED for the checkout
-- page's Leave (a stale tab must not cancel an order another tab placed). The row is locked FOR NO KEY
-- UPDATE, the level the status UPDATE takes anyway, which does not conflict with the KEY SHARE locks of
-- foreign-key checks; under READ COMMITTED a concurrent payment, expiry or cancel that commits first is seen
-- by the re-check, so the status reported as fromStatus is the one this UPDATE replaces.
--
-- One row: cancelled, with the status it left. No row: nothing changed (another user's order, an unknown
-- id, or no longer in p_from); the caller re-reads and classifies.
--
-- The event is the orders.v1 order.cancelled envelope of packages/contracts (OrderEvent, schemaVersion 1),
-- with the uuidv7 event id and the optional trace id from the caller. Its version and time are Postgres's,
-- so it is built here; occurredAt prints like JavaScript's toISOString() of updated_at, milliseconds
-- truncated as a Date truncates the microseconds Postgres stores. packages/db/src/checkout.int.test.ts pins
-- it to the row the TypeScript producer path writes; a breaking change is a new topic and a new function.
CREATE FUNCTION fd_cancel_order(p_order_id uuid, p_user_id uuid, p_from order_status[], p_event_id uuid,
                                p_trace_id text)
RETURNS TABLE (cancelled_order orders, from_status order_status)
LANGUAGE plpgsql AS $$
BEGIN
  SELECT o.status INTO from_status FROM orders o
  WHERE o.id = p_order_id AND o.user_id = p_user_id AND o.status = ANY (p_from)
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE orders SET status = 'CANCELLED', close_reason = 'USER', closed_at = now(),
                    version = version + 1, updated_at = now()
  WHERE id = p_order_id
  RETURNING * INTO cancelled_order;

  UPDATE user_drop_quota SET claimed = claimed - cancelled_order.qty
  WHERE user_id = cancelled_order.user_id AND drop_id = cancelled_order.drop_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fd_cancel_order: no quota row for user % in drop %',
      cancelled_order.user_id, cancelled_order.drop_id;
  END IF;

  INSERT INTO outbox (event_id, topic, partition_key, event_type, payload, headers)
  VALUES (
    p_event_id, 'orders.v1', cancelled_order.product_id::text, 'order.cancelled',
    jsonb_build_object(
      'eventId', p_event_id,
      'schemaVersion', 1,
      'type', 'order.cancelled',
      'occurredAt', to_char(cancelled_order.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'orderId', cancelled_order.id,
      'orderVersion', cancelled_order.version,
      'productId', cancelled_order.product_id,
      'dropId', cancelled_order.drop_id,
      'userId', cancelled_order.user_id,
      'data', jsonb_build_object('qty', cancelled_order.qty, 'fromStatus', from_status))
      || CASE WHEN p_trace_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('traceId', p_trace_id) END,
    CASE WHEN p_trace_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('trace-id', p_trace_id) END);

  UPDATE drop_inventory SET reserved = reserved - cancelled_order.qty
  WHERE drop_id = cancelled_order.drop_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fd_cancel_order: no inventory row for drop %', cancelled_order.drop_id;
  END IF;
  RETURN NEXT;
END
$$;
