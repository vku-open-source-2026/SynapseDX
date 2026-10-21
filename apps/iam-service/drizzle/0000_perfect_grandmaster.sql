CREATE TABLE IF NOT EXISTS "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"actor_id" text DEFAULT '' NOT NULL,
	"action" text NOT NULL,
	"resource" text DEFAULT '' NOT NULL,
	"decision" boolean NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '',
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_policies" (
	"role_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	CONSTRAINT "role_policies_role_id_policy_id_pk" PRIMARY KEY("role_id","policy_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"external_sub" text,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "accounts" ADD CONSTRAINT "accounts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "workflows" ADD CONSTRAINT "workflows_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "policies" ADD CONSTRAINT "policies_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "role_policies" ADD CONSTRAINT "role_policies_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "role_policies" ADD CONSTRAINT "role_policies_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "roles" ADD CONSTRAINT "roles_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_org_id_slug_key" ON "accounts" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_accounts_org" ON "accounts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hash_key" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_keys_prefix" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_keys_expiry" ON "api_keys" USING btree ("expires_at") WHERE "api_keys"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_keys_account" ON "api_keys" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_actor" ON "audit_log" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_time" ON "audit_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_action" ON "audit_log" USING btree ("action","decision");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflows_account_id_slug_key" ON "workflows" USING btree ("account_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflows_account" ON "workflows" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_key" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "policies_account_id_slug_key" ON "policies" USING btree ("account_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_policies_account" ON "policies" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_token_hash_key" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_refresh_expiry" ON "refresh_tokens" USING btree ("expires_at") WHERE "refresh_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_user" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "roles_account_id_slug_key" ON "roles" USING btree ("account_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_roles_account" ON "roles" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_accounts_account_id_slug_key" ON "service_accounts" USING btree ("account_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_service_accounts_account" ON "service_accounts" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_org_id_email_key" ON "users" USING btree ("org_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_external_sub" ON "users" USING btree ("external_sub") WHERE "users"."external_sub" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_org_email_lower" ON "users" USING btree ("org_id",lower("email"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_org" ON "users" USING btree ("org_id");
--> statement-breakpoint
INSERT INTO organizations (slug, display_name)
VALUES ('acme', 'ACME Demo Organization')
ON CONFLICT (slug) DO NOTHING;
--> statement-breakpoint
INSERT INTO accounts (org_id, slug, display_name)
SELECT id, 'prod', 'Production' FROM organizations WHERE slug='acme'
ON CONFLICT (org_id, slug) DO NOTHING;
