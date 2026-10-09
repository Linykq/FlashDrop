-- drops.ended_at (0011) is when the drop became ENDED (design §9): the dashboard's "ran for" and sell-out
-- time come from it, and the schedule says nothing once an admin ends a drop early. A drop ends on several
-- paths (the admin's end, a resume past the window, the scheduler, and the seed and test fixtures that insert
-- one ENDED), so a trigger sets it, as drop_inventory_touch (0003) sets updated_at: no statement can forget.
--
-- least(now(), ends_at): an early end is the moment it happened; a drop the clock closed ended at its
-- scheduled end, not when a scheduler tick (or a resume) got round to it. now() is the writer's transaction
-- start. A value the writer sets itself (the seed's history) is kept. Only an ENDED drop has one: ENDED is
-- terminal for the application, and the development seed, which moves an idle ended drop back into a future
-- window, gets its ended_at cleared with it.
CREATE FUNCTION drops_ended_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'ENDED' THEN
    NEW.ended_at := NULL;
  ELSIF NEW.ended_at IS NULL THEN
    NEW.ended_at := least(now(), NEW.ends_at);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER drops_ended_at BEFORE INSERT OR UPDATE OF status ON drops
  FOR EACH ROW EXECUTE FUNCTION drops_ended_at();
--> statement-breakpoint
-- Drops that ended before this migration: their scheduled end is the best record there is.
UPDATE drops SET ended_at = ends_at WHERE status = 'ENDED' AND ended_at IS NULL;
