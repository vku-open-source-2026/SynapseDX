DROP INDEX IF EXISTS "idx_base_documents_data";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_documents_data" ON "synapseone_base_documents" USING gin ("data" jsonb_path_ops);
