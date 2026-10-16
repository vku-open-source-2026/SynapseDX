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
  // Executions live in the local engine (always up with workflow-service).
  // Only tolerate a truly-down service (502/503) — auth/shape errors still fail.
  // listExecutions() unwraps the {data: []} envelope to a plain array.
  try {
    const execs = await c.listExecutions('limit=1');
    console.log('SDK_EXECUTIONS', JSON.stringify(execs).slice(0, 120), Array.isArray(execs) ? 'array-ok' : 'NOT-ARRAY');
    const filtered = await c.listExecutions({ limit: 1, status: 'success' });
    console.log('SDK_EXECUTIONS_DICT', Array.isArray(filtered) ? 'array-ok' : 'NOT-ARRAY');
    const tr = await c.testRun({ nodes: [], connections: {} }, {});
    console.log('SDK_TEST_RUN', JSON.stringify(tr).slice(0, 120));
  } catch (e) {
    if (/502|503|unreachable|bad_gateway/.test(e.message)) {
      console.log('SDK_EXECUTIONS_SKIPPED workflow-down');
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
