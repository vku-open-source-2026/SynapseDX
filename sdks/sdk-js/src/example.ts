/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { SynapseOneClient } from './index';

async function main() {
  const c = new SynapseOneClient({ baseUrl: process.env.SYNAPSEONE_BASE_URL || 'http://localhost:8080' });
  const login = await c.login('demo@acme.local');
  console.log('login ok:', login.user?.email);
  c.setToken(login.accessToken);
  console.log(await c.listOrgs());
  console.log('lds datasources:', await c.ldsDatasources());
}
main().catch((e) => { console.error(e); process.exit(1); });
