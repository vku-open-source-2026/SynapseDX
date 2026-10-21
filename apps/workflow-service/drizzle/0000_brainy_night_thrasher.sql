CREATE TABLE IF NOT EXISTS "synapsedx_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"org_id" text,
	"name" text NOT NULL,
	"kind" text DEFAULT 'bearer' NOT NULL,
	"secret_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "synapsedx_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'success' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"node_runs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"triggered_by" text DEFAULT 'manual' NOT NULL,
	"principal" jsonb,
	"actor" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "synapsedx_workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"nodes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"org_id" text,
	"account_id" text,
	"owner_sub" text,
	"run_as" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE synapsedx_workflows ADD COLUMN IF NOT EXISTS org_id TEXT;
ALTER TABLE synapsedx_workflows ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE synapsedx_workflows ADD COLUMN IF NOT EXISTS owner_sub TEXT;
ALTER TABLE synapsedx_workflows ADD COLUMN IF NOT EXISTS run_as TEXT;
ALTER TABLE synapsedx_workflows ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE synapsedx_executions ADD COLUMN IF NOT EXISTS principal JSONB;
ALTER TABLE synapsedx_executions ADD COLUMN IF NOT EXISTS actor TEXT;
ALTER TABLE synapsedx_credentials ADD COLUMN IF NOT EXISTS org_id TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "synapsedx_credentials_account_id_name_key" ON "synapsedx_credentials" USING btree ("account_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_synapsedx_credentials_account" ON "synapsedx_credentials" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_synapsedx_credentials_org" ON "synapsedx_credentials" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_synapsedx_exec_workflow" ON "synapsedx_executions" USING btree ("workflow_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_synapsedx_exec_status" ON "synapsedx_executions" USING btree ("status","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_synapsedx_exec_time" ON "synapsedx_executions" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_synapsedx_exec_principal_org" ON "synapsedx_executions" USING btree (("principal"->>'org')) WHERE "synapsedx_executions"."principal" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_synapsedx_exec_principal_account" ON "synapsedx_executions" USING btree (("principal"->>'account')) WHERE "synapsedx_executions"."principal" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_synapsedx_workflows_active" ON "synapsedx_workflows" USING btree ("active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_synapsedx_workflows_tenant" ON "synapsedx_workflows" USING btree ("org_id","account_id");