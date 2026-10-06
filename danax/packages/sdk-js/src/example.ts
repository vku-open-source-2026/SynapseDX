import { DanaxClient } from './index';

async function main() {
  const c = new DanaxClient({ baseUrl: process.env.DANAX_BASE_URL || 'http://localhost:8080' });
  const login = await c.login('demo@acme.local');
  console.log('login ok:', login.user?.email);
  c.setToken(login.accessToken);
  console.log(await c.listOrgs());
}
main().catch((e) => { console.error(e); process.exit(1); });
