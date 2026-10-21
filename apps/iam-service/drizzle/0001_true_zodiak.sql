CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text DEFAULT '' NOT NULL,
	"feature" text NOT NULL,
	"route" text NOT NULL,
	"method" text NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"status" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"auth_kind" text DEFAULT 'unknown' NOT NULL,
	"org_id" uuid,
	"account_id" uuid,
	"user_id" uuid,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "idx_usage_time" ON "usage_events" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_usage_org_time" ON "usage_events" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_usage_feature_time" ON "usage_events" USING btree ("feature","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_usage_status" ON "usage_events" USING btree ("status");