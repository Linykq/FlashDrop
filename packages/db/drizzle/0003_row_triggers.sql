-- orders_guard, second version (design §3, §4.4). Applied migrations are never edited (M0 delta 9), so this
-- replaces the function from 0001; CREATE OR REPLACE keeps its identity, and the existing trigger runs the new
-- body. New: an order's identity and amounts are frozen from its insert on, whatever its status. 0001 checked
-- only the status edge of a live order, so a buggy `UPDATE orders SET qty = ...` on a held order, alone or
-- inside a legal transition, would have broken INV-2 (inventory.reserved and quota.claimed would no longer
-- equal the sum of qty) without an error. total_cents follows from qty and unit_price_cents; it is still NULL
-- in NEW inside a BEFORE trigger, so it is never compared (M0 delta 8).
CREATE OR REPLACE FUNCTION orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('RESERVED', 'REJECTED') THEN
      RAISE EXCEPTION 'orders_guard: an order cannot be inserted as %', NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.user_id, NEW.drop_id, NEW.product_id, NEW.qty, NEW.unit_price_cents, NEW.currency,
      NEW.idempotency_key, NEW.request_hash, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.drop_id, OLD.product_id, OLD.qty, OLD.unit_price_cents, OLD.currency,
      OLD.idempotency_key, OLD.request_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'orders_guard: the identity and amounts of order % never change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_guard';
  END IF;

  IF OLD.status NOT IN ('RESERVED', 'PENDING_PAYMENT') THEN
    IF (to_jsonb(NEW) - 'redis_settled_at' - 'total_cents')
       IS DISTINCT FROM (to_jsonb(OLD) - 'redis_settled_at' - 'total_cents') THEN
      RAISE EXCEPTION 'orders_guard: order % is terminal (%)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_guard';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'RESERVED' AND NEW.status IN ('PENDING_PAYMENT', 'EXPIRED', 'CANCELLED'))
    OR (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'orders_guard: illegal transition % -> % for order %', OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_guard';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- drop_inventory.updated_at is "set by every update" (design §3): the reconciler counts a leak sample as
-- quiescent only while (seq, updated_at) stay the same (§4.7), so an UPDATE that forgot to set it would make a
-- changing row look still. The trigger sets it on every UPDATE, whatever the statement says, and keeps that
-- detail out of the hot-path SQL. now() is the writer's transaction start: the check needs every write to
-- change the value, not the values to increase.
CREATE FUNCTION drop_inventory_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER drop_inventory_touch BEFORE UPDATE ON drop_inventory
  FOR EACH ROW EXECUTE FUNCTION drop_inventory_touch();
