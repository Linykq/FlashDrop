CREATE TABLE "psp_closures" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "psp_closures" ADD CONSTRAINT "psp_closures_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_close_owed" ON "orders" USING btree ("closed_at") WHERE "orders"."checkout_key" IS NOT NULL AND "orders"."status" IN ('EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE INDEX "charges_reference_idx" ON "psp"."charges" USING btree ("reference");