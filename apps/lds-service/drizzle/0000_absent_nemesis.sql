CREATE TABLE IF NOT EXISTS "lds_attributes" (
	"datasource_id" text NOT NULL,
	"name" text NOT NULL,
	"ngsi_ld_type" text DEFAULT 'Property' NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"description" text,
	"source_field" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lds_attributes_datasource_id_name_pk" PRIMARY KEY("datasource_id","name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lds_datasources" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"entity_type" text NOT NULL,
	"license" text NOT NULL,
	"license_url" text,
	"contexts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_visibility" text DEFAULT 'internal' NOT NULL,
	"description" text,
	"org_id" text,
	"account_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lds_records" (
	"datasource_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"source_record_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"core" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entity" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lds_records_datasource_id_entity_id_pk" PRIMARY KEY("datasource_id","entity_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lds_attributes" ADD CONSTRAINT "lds_attributes_datasource_id_fkey" FOREIGN KEY ("datasource_id") REFERENCES "public"."lds_datasources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lds_records" ADD CONSTRAINT "lds_records_datasource_id_fkey" FOREIGN KEY ("datasource_id") REFERENCES "public"."lds_datasources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_lds_datasources_scope_slug" ON "lds_datasources" USING btree (coalesce("org_id", ''),"slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lds_datasources_tenant" ON "lds_datasources" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lds_records_ds" ON "lds_records" USING btree ("datasource_id","updated_at" DESC NULLS LAST);