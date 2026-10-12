/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { SynapseDXClient } from './index';

async function main() {
  const c = new SynapseDXClient({ baseUrl: process.env.SYNAPSEDX_BASE_URL || 'http://localhost:8080' });
  const login = await c.login('demo@acme.local');
  console.log('login ok:', login.user?.email);
  c.setToken(login.accessToken);
  console.log(await c.listOrgs());
}
main().catch((e) => { console.error(e); process.exit(1); });
