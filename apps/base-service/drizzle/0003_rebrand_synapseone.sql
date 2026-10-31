-- Rebrand migration: SynapseDX -> SynapseOne table/constraint renames.
-- Fresh installs already create the new names (0000/0002 were rebranded in
-- place), so every statement is conditional and becomes a no-op there. Existing
-- volumes created before the rebrand keep their data and are renamed in place.
DO $$ BEGIN
  IF to_regclass('public.synapsedx_base_collections') IS NOT NULL
     AND to_regclass('public.synapseone_base_collections') IS NULL THEN
    ALTER TABLE public.synapsedx_base_collections RENAME TO synapseone_base_collections;
  END IF;
  IF to_regclass('public.synapsedx_base_documents') IS NOT NULL
     AND to_regclass('public.synapseone_base_documents') IS NULL THEN
    ALTER TABLE public.synapsedx_base_documents RENAME TO synapseone_base_documents;
  END IF;
  IF to_regclass('public.synapsedx_base_vectors') IS NOT NULL
     AND to_regclass('public.synapseone_base_vectors') IS NULL THEN
    ALTER TABLE public.synapsedx_base_vectors RENAME TO synapseone_base_vectors;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_base_collections'::regclass AND conname = 'synapsedx_base_collections_pkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_base_collections'::regclass AND conname = 'synapseone_base_collections_pkey') THEN
    ALTER TABLE public.synapseone_base_collections RENAME CONSTRAINT "synapsedx_base_collections_pkey" TO "synapseone_base_collections_pkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_base_documents'::regclass AND conname = 'synapsedx_base_documents_collection_id_id_pk')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_base_documents'::regclass AND conname = 'synapseone_base_documents_collection_id_id_pk') THEN
    ALTER TABLE public.synapseone_base_documents RENAME CONSTRAINT "synapsedx_base_documents_collection_id_id_pk" TO "synapseone_base_documents_collection_id_id_pk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_base_documents'::regclass AND conname = 'synapsedx_base_documents_collection_id_fkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_base_documents'::regclass AND conname = 'synapseone_base_documents_collection_id_fkey') THEN
    ALTER TABLE public.synapseone_base_documents RENAME CONSTRAINT "synapsedx_base_documents_collection_id_fkey" TO "synapseone_base_documents_collection_id_fkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_base_vectors'::regclass AND conname = 'synapsedx_base_vectors_collection_id_document_id_field_name_pk')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_base_vectors'::regclass AND conname = 'synapseone_base_vectors_collection_id_document_id_field_name_pk') THEN
    ALTER TABLE public.synapseone_base_vectors RENAME CONSTRAINT "synapsedx_base_vectors_collection_id_document_id_field_name_pk" TO "synapseone_base_vectors_collection_id_document_id_field_name_pk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_base_vectors'::regclass AND conname = 'synapsedx_base_vectors_collection_id_fkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_base_vectors'::regclass AND conname = 'synapseone_base_vectors_collection_id_fkey') THEN
    ALTER TABLE public.synapseone_base_vectors RENAME CONSTRAINT "synapsedx_base_vectors_collection_id_fkey" TO "synapseone_base_vectors_collection_id_fkey";
  END IF;
END $$;
