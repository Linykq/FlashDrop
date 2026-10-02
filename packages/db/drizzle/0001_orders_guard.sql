-- orders_guard (design §3, §4.4): orders are inserted only as RESERVED (a granted hold) or REJECTED (a
-- refusal tombstone); a live order changes status only along the §4.4 edges; a terminal order is immutable
-- apart from redis_settled_at. Every status change in the code is already a CAS on the expected status, so
-- the trigger fires only on a bug, and stops it before the counters and the orders disagree.
--
-- In a BEFORE trigger the stored generated column total_cents is still NULL in NEW, so the terminal-row
-- comparison leaves it out (M0 spike, design delta 8). The packages/db integration test checks this
-- function edge by edge against ORDER_TRANSITIONS in @flashdrop/domain.
CREATE FUNCTION orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('RESERVED', 'REJECTED') THEN
      RAISE EXCEPTION 'orders_guard: an order cannot be inserted as %', NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_guard';
    END IF;
    RETURN NEW;
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
CREATE TRIGGER orders_guard BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION orders_guard();
