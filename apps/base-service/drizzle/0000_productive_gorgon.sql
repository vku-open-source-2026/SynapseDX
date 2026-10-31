CREATE TABLE IF NOT EXISTS "synapseone_base_collections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"mapping" jsonb DEFAULT '{"fields":{}}'::jsonb NOT NULL,
	"org_id" text,
	"account_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "synapseone_base_documents" (
	"collection_id" text NOT NULL,
	"id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synapseone_base_documents_collection_id_id_pk" PRIMARY KEY("collection_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "synapseone_base_documents" ADD CONSTRAINT "synapseone_base_documents_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "public"."synapseone_base_collections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_base_collections_scope_name" ON "synapseone_base_collections" USING btree (coalesce("org_id", ''),coalesce("account_id", ''),"name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_collections_tenant" ON "synapseone_base_collections" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_collections_org_name" ON "synapseone_base_collections" USING btree ("org_id","name","created_at") WHERE "synapseone_base_collections"."org_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_collections_account_name" ON "synapseone_base_collections" USING btree ("account_id","name") WHERE "synapseone_base_collections"."org_id" is null and "synapseone_base_collections"."account_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_collections_global_name" ON "synapseone_base_collections" USING btree ("name") WHERE "synapseone_base_collections"."org_id" is null and "synapseone_base_collections"."account_id" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_documents_updated" ON "synapseone_base_documents" USING btree ("collection_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_documents_changes" ON "synapseone_base_documents" USING btree ("collection_id","updated_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_documents_data" ON "synapseone_base_documents" USING gin ("data" jsonb_path_ops);