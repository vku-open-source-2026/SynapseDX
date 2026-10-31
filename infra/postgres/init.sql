-- SynapseOne database bootstrap.
--
-- Table and index DDL is owned by each service's versioned Drizzle migrations
-- (apps/*/drizzle). Services apply their own migrations on startup using a
-- per-service migration journal, so this file only needs database-level setup
-- that must exist before the first service boots.
--
-- Keep this file minimal: do not duplicate application tables, indexes or demo
-- seed data here.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Drizzle stores each service's migration journal here. Create it up front so
-- concurrent first-boot migrations don't race on schema creation.
CREATE SCHEMA IF NOT EXISTS "drizzle";
