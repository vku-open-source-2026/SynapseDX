/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 * Legacy env compatibility: services prefer SYNAPSEONE_* but keep honouring
 * SYNAPSEDX_* during the rebrand window. New names win when both are set.
 */
import dotenv from 'dotenv';

// ESM imports run before a service's own `dotenv.config()`, so load .env here
// too; dotenv never overrides variables that are already set.
dotenv.config();

for (const key of Object.keys(process.env)) {
  if (!key.startsWith('SYNAPSEDX_')) continue;
  const next = `SYNAPSEONE_${key.slice('SYNAPSEDX_'.length)}`;
  if (!process.env[next]) process.env[next] = process.env[key];
}

export {};
