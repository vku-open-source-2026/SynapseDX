/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
const { SynapseDXClient } = require('../../sdks/sdk-js/dist/index.js');

async function main() {
  const c = new SynapseDXClient({ baseUrl: process.env.SYNAPSEDX_BASE_URL || 'http://127.0.0.1:18110' });
  const login = await c.login('sdksim@acme.local');
  c.setToken(login.accessToken);
  console.log('SDK_ME', (await c.me()).user.email);
  console.log('SDK_VERIFY', (await c.verify()).valid);
  console.log('SDK_AUDIT', (await c.listAudit(5)).length);
  const orgs = await c.listOrgs();
  const acc = await c.createAccount(orgs[0].id, 'sdkacc', 'SDK');
  console.log('SDK_USERS', (await c.listUsers(orgs[0].id)).length);
  console.log('SDK_TEMPLATES', (await c.listTemplates()).length);
  console.log('SDK_TEMPLATE_ONE', (await c.getTemplate('webhook-to-log')).name);
  // Executions proxy to n8n, which may be absent OR unprovisioned in CI:
  // - engine down -> 502 n8n_unreachable / bad_gateway (fail-closed, clean error)
  // - engine up but N8N_API_KEY placeholder -> n8n's own 401 {"message":"unauthorized"}
  //   (message-ONLY shape; OUR 401s always carry an "error" key — those still fail).
  // Either case means the SDK + gateway + workflow path works; only fail otherwise.
  try {
    console.log('SDK_EXECUTIONS', JSON.stringify(await c.listExecutions('limit=1')).slice(0, 120));
  } catch (e) {
    if (/502|n8n_unreachable|bad_gateway|"message":"unauthorized"/.test(e.message)) {
      console.log('SDK_EXECUTIONS_SKIPPED n8n-absent-or-unprovisioned');
    } else {
      throw e;
    }
  }
  console.log('SDK_ROLES', JSON.stringify(await c.listRoles(acc.id)));
  console.log('SDK_POLICIES', JSON.stringify(await c.listPolicies(acc.id)));
  console.log('SDK_SIM', JSON.stringify(await c.simulate(
    [{ Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] }], 'x:Y', '*')));
  const sa = await c.createServiceAccount(acc.id, 'sdk-sa');
  console.log('SDK_SA', sa.slug);
  console.log('SDK_SA_TOK', (await c.serviceAccountToken(sa.id)).accessToken.slice(0, 20) + '...');
}
main().catch((e) => { console.error('SDK_FAIL', e.message); process.exit(1); });
