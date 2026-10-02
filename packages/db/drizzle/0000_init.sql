CREATE SCHEMA "psp";
--> statement-breakpoint
CREATE TYPE "public"."drop_status" AS ENUM('DRAFT', 'SCHEDULED', 'LIVE', 'PAUSED', 'ENDED');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('RESERVED', 'PENDING_PAYMENT', 'PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('SUCCEEDED', 'FAILED', 'REFUNDED');--> statement-breakpoint
CREATE TABLE "drop_inventory" (
	"drop_id" uuid PRIMARY KEY NOT NULL,
	"total" integer NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"sold" integer DEFAULT 0 NOT NULL,
	"redis_gen" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drop_inventory_total_check" CHECK ("drop_inventory"."total" > 0),
	CONSTRAINT "drop_inventory_reserved_check" CHECK ("drop_inventory"."reserved" >= 0),
	CONSTRAINT "drop_inventory_sold_check" CHECK ("drop_inventory"."sold" >= 0),
	CONSTRAINT "no_oversell" CHECK ("drop_inventory"."reserved" + "drop_inventory"."sold" <= "drop_inventory"."total")
);
--> statement-breakpoint
CREATE TABLE "drops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"room_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"per_user_limit" integer NOT NULL,
	"hold_seconds" integer DEFAULT 120 NOT NULL,
	"payment_seconds" integer DEFAULT 300 NOT NULL,
	"status" "drop_status" DEFAULT 'DRAFT' NOT NULL,
	CONSTRAINT "drops_window" CHECK ("drops"."ends_at" > "drops"."starts_at"),
	CONSTRAINT "drops_price_cents_check" CHECK ("drops"."price_cents" > 0),
	CONSTRAINT "drops_per_user_limit_check" CHECK ("drops"."per_user_limit" BETWEEN 1 AND 10),
	CONSTRAINT "drops_hold_seconds_check" CHECK ("drops"."hold_seconds" BETWEEN 10 AND 900),
	CONSTRAINT "drops_payment_seconds_check" CHECK ("drops"."payment_seconds" BETWEEN 10 AND 1800)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"image_keys" text[] NOT NULL,
	"status" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"listing_job_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_key" UNIQUE("slug"),
	CONSTRAINT "products_title_check" CHECK (char_length("products"."title") BETWEEN 10 AND 80),
	CONSTRAINT "products_status_check" CHECK ("products"."status" IN ('DRAFT', 'PUBLISHED')),
	CONSTRAINT "products_source_check" CHECK ("products"."source" IN ('manual', 'llm'))
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"hls_url" text NOT NULL,
	CONSTRAINT "rooms_slug_key" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'buyer' NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('buyer', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"drop_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"total_cents" integer GENERATED ALWAYS AS (qty * unit_price_cents) STORED,
	"currency" char(3) NOT NULL,
	"status" "order_status" NOT NULL,
	"close_reason" text,
	"idempotency_key" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"checkout_key" text,
	"checkout_hash" "bytea",
	"shipping" jsonb,
	"payment_method" text,
	"expires_at" timestamp with time zone NOT NULL,
	"extensions" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"redis_settled_at" timestamp with time zone,
	CONSTRAINT "orders_user_drop_idempotency_key" UNIQUE("user_id","drop_id","idempotency_key"),
	CONSTRAINT "orders_qty_check" CHECK ("orders"."qty" BETWEEN 1 AND 10),
	CONSTRAINT "orders_unit_price_cents_check" CHECK ("orders"."unit_price_cents" > 0),
	CONSTRAINT "orders_close_reason_check" CHECK ("orders"."close_reason" IN ('TIMEOUT', 'USER', 'DECLINED', 'SOLD_OUT', 'LIMIT', 'NOT_LIVE', 'ORPHANED')),
	CONSTRAINT "orders_extensions_check" CHECK ("orders"."extensions" BETWEEN 0 AND 1),
	CONSTRAINT "orders_paid_at_matches_status" CHECK (("orders"."status" = 'PAID') = ("orders"."paid_at" IS NOT NULL)),
	CONSTRAINT "orders_closed_at_matches_status" CHECK (("orders"."status" IN ('RESERVED', 'PENDING_PAYMENT', 'PAID')) = ("orders"."closed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"partition_key" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "outbox_event_id_key" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"psp_charge_id" text,
	"amount_cents" integer NOT NULL,
	"status" "payment_status" NOT NULL,
	"decline_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_psp_charge_id_key" UNIQUE("psp_charge_id"),
	CONSTRAINT "payments_amount_cents_check" CHECK ("payments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_pkey" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE TABLE "sweeper_quarantine" (
	"loop" text NOT NULL,
	"order_id" uuid NOT NULL,
	"error" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sweeper_quarantine_pkey" PRIMARY KEY("loop","order_id")
);
--> statement-breakpoint
CREATE TABLE "user_drop_quota" (
	"user_id" uuid NOT NULL,
	"drop_id" uuid NOT NULL,
	"claimed" integer NOT NULL,
	"limit_qty" integer NOT NULL,
	CONSTRAINT "user_drop_quota_pkey" PRIMARY KEY("user_id","drop_id"),
	CONSTRAINT "within_limit" CHECK ("user_drop_quota"."claimed" BETWEEN 0 AND "user_drop_quota"."limit_qty")
);
--> statement-breakpoint
CREATE TABLE "psp"."charges" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"reference" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refunded_at" timestamp with time zone,
	CONSTRAINT "charges_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "charges_status_check" CHECK ("psp"."charges"."status" IN ('succeeded', 'declined', 'refunded'))
);
--> statement-breakpoint
CREATE TABLE "psp"."references" (
	"reference" text PRIMARY KEY NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drop_sales_totals" (
	"drop_id" uuid PRIMARY KEY NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"placed" integer DEFAULT 0 NOT NULL,
	"paid" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"expired" integer DEFAULT 0 NOT NULL,
	"cancelled" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"units_sold" integer DEFAULT 0 NOT NULL,
	"revenue_cents" bigint DEFAULT 0 NOT NULL,
	"last_event_at" timestamp with time zone,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_by" uuid NOT NULL,
	"status" text NOT NULL,
	"image_keys" text[] NOT NULL,
	"hints" text,
	"input_hash" "bytea" NOT NULL,
	"provider" text,
	"model" text,
	"prompt_version" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"draft" jsonb,
	"final" jsonb,
	"issues" jsonb,
	"usage" jsonb,
	"cost_usd" numeric(10, 5),
	"latency_ms" integer,
	"product_id" uuid,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_jobs_status_check" CHECK ("listing_jobs"."status" IN ('PENDING', 'RUNNING', 'READY', 'NEEDS_REVIEW', 'FAILED', 'APPROVED'))
);
--> statement-breakpoint
CREATE TABLE "sales_minute" (
	"drop_id" uuid NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"placed" integer DEFAULT 0 NOT NULL,
	"paid" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"expired" integer DEFAULT 0 NOT NULL,
	"cancelled" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"units_sold" integer DEFAULT 0 NOT NULL,
	"revenue_cents" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "sales_minute_pkey" PRIMARY KEY("drop_id","minute")
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drop_inventory" ADD CONSTRAINT "drop_inventory_drop_id_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."drops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drops" ADD CONSTRAINT "drops_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drops" ADD CONSTRAINT "drops_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_drop_id_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."drops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sweeper_quarantine" ADD CONSTRAINT "sweeper_quarantine_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_drop_quota" ADD CONSTRAINT "user_drop_quota_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_drop_quota" ADD CONSTRAINT "user_drop_quota_drop_id_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."drops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_jobs" ADD CONSTRAINT "listing_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_jobs" ADD CONSTRAINT "listing_jobs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_drop_per_product" ON "drops" USING btree ("product_id") WHERE "drops"."status" IN ('SCHEDULED', 'LIVE', 'PAUSED');--> statement-breakpoint
CREATE INDEX "orders_due" ON "orders" USING btree ("expires_at") WHERE "orders"."status" IN ('RESERVED', 'PENDING_PAYMENT');--> statement-breakpoint
CREATE INDEX "orders_unsettled" ON "orders" USING btree ("updated_at") WHERE "orders"."redis_settled_at" IS NULL AND "orders"."status" IN ('PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED', 'REJECTED');--> statement-breakpoint
CREATE INDEX "outbox_pending" ON "outbox" USING btree ("id") WHERE "outbox"."published_at" IS NULL;