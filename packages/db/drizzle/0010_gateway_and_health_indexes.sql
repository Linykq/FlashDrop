ALTER TABLE "listing_jobs" ADD COLUMN "unavailable_since" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "drops_room_id" ON "drops" USING btree ("room_id") WHERE "drops"."status" <> 'DRAFT';--> statement-breakpoint
CREATE INDEX "outbox_partition_key" ON "outbox" USING btree ("partition_key");