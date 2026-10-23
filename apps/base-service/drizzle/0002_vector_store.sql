DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS "vector";
EXCEPTION WHEN OTHERS THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "synapsedx_base_vectors" (
	"collection_id" text NOT NULL,
	"document_id" text NOT NULL,
	"field_name" text NOT NULL,
	"embedding" text NOT NULL,
	"dimension" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synapsedx_base_vectors_collection_id_document_id_field_name_pk" PRIMARY KEY("collection_id","document_id","field_name")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "synapsedx_base_vectors" ADD CONSTRAINT "synapsedx_base_vectors_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "public"."synapsedx_base_collections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_vectors_lookup" ON "synapsedx_base_vectors" USING btree ("collection_id","field_name");
