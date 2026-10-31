-- Rebrand migration: SynapseDX -> SynapseOne table/constraint/index renames.
-- Fresh installs already create the new names (0000 was rebranded in place), so
-- every statement is conditional and becomes a no-op there. Existing volumes
-- created before the rebrand keep their data and are renamed in place.
DO $$ BEGIN
  IF to_regclass('public.synapsedx_workflows') IS NOT NULL
     AND to_regclass('public.synapseone_workflows') IS NULL THEN
    ALTER TABLE public.synapsedx_workflows RENAME TO synapseone_workflows;
  END IF;
  IF to_regclass('public.synapsedx_executions') IS NOT NULL
     AND to_regclass('public.synapseone_executions') IS NULL THEN
    ALTER TABLE public.synapsedx_executions RENAME TO synapseone_executions;
  END IF;
  IF to_regclass('public.synapsedx_credentials') IS NOT NULL
     AND to_regclass('public.synapseone_credentials') IS NULL THEN
    ALTER TABLE public.synapsedx_credentials RENAME TO synapseone_credentials;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_workflows'::regclass AND conname = 'synapsedx_workflows_pkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_workflows'::regclass AND conname = 'synapseone_workflows_pkey') THEN
    ALTER TABLE public.synapseone_workflows RENAME CONSTRAINT "synapsedx_workflows_pkey" TO "synapseone_workflows_pkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_executions'::regclass AND conname = 'synapsedx_executions_pkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_executions'::regclass AND conname = 'synapseone_executions_pkey') THEN
    ALTER TABLE public.synapseone_executions RENAME CONSTRAINT "synapsedx_executions_pkey" TO "synapseone_executions_pkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_credentials'::regclass AND conname = 'synapsedx_credentials_pkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.synapseone_credentials'::regclass AND conname = 'synapseone_credentials_pkey') THEN
    ALTER TABLE public.synapseone_credentials RENAME CONSTRAINT "synapsedx_credentials_pkey" TO "synapseone_credentials_pkey";
  END IF;
END $$;
--> statement-breakpoint
ALTER INDEX IF EXISTS public."synapsedx_credentials_account_id_name_key" RENAME TO "synapseone_credentials_account_id_name_key";
--> statement-breakpoint
ALTER INDEX IF EXISTS public."idx_synapsedx_credentials_account" RENAME TO "idx_synapseone_credentials_account";
--> statement-breakpoint
ALTER INDEX IF EXISTS public."idx_synapsedx_credentials_org" RENAME TO "idx_synapseone_credentials_org";
--> statement-breakpoint
ALTER INDEX IF EXISTS public."idx_synapsedx_exec_workflow" RENAME TO "idx_synapseone_exec_workflow";
--> statement-breakpoint
ALTER INDEX IF EXISTS public."idx_synapsedx_exec_status" RENAME TO "idx_synapseone_exec_status";
--> statement-breakpoint
ALTER INDEX IF EXISTS public."idx_synapsedx_exec_time" RENAME TO "idx_synapseone_exec_time";
--> statement-breakpoint
ALTER INDEX IF EXISTS public."idx_synapsedx_exec_principal_org" RENAME TO "idx_synapseone_exec_principal_org";
--> statement-breakpoint
ALTER INDEX IF EXISTS public."idx_synapsedx_exec_principal_account" RENAME TO "idx_synapseone_exec_principal_account";
--> statement-breakpoint
ALTER INDEX IF EXISTS public."idx_synapsedx_workflows_active" RENAME TO "idx_synapseone_workflows_active";
--> statement-breakpoint
ALTER INDEX IF EXISTS public."idx_synapsedx_workflows_tenant" RENAME TO "idx_synapseone_workflows_tenant";
