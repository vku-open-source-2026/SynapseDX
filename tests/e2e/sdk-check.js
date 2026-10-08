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
  console.log('SDK_EXECUTIONS', JSON.stringify(await c.listExecutions('limit=1')).slice(0, 120));
  console.log('SDK_ROLES', JSON.stringify(await c.listRoles(acc.id)));
  console.log('SDK_POLICIES', JSON.stringify(await c.listPolicies(acc.id)));
  console.log('SDK_SIM', JSON.stringify(await c.simulate(
    [{ Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] }], 'x:Y', '*')));
  const sa = await c.createServiceAccount(acc.id, 'sdk-sa');
  console.log('SDK_SA', sa.slug);
  console.log('SDK_SA_TOK', (await c.serviceAccountToken(sa.id)).accessToken.slice(0, 20) + '...');
}
main().catch((e) => { console.error('SDK_FAIL', e.message); process.exit(1); });
