import React, { useState } from 'react';
import { Card, Code, PageTitle } from '../components/ui.jsx';

const TABS = ['Console', 'JavaScript', 'Python', 'Go', 'CLI'];

const SNIPPETS = {
  Console: `# Truy cập UI quản trị
open http://localhost:3000            # compose: console service
# login: demo@acme.local / org acme  (hoặc X-API-Key)

# Đổi backend khi gateway không ở :8080 (ví dụ :18080):
CONSOLE_HOST_PORT=3000 DANAX_PUBLIC_BASE_URL=http://localhost:18080 \\
  docker compose up -d console`,
  JavaScript: `// npm i @danax/sdk   (sau khi publish; dev: dùng packages/sdk-js)
import { DanaxClient } from '@danax/sdk';

const c = new DanaxClient({ baseUrl: 'http://localhost:8080' });
const { accessToken, user } = await c.login('demo@acme.local');
c.setToken(accessToken);

await c.createOrg('acme-2', 'ACME 2');
await c.authorize(user.id, 'workflow:Execute', '*', { team: 'etl' });
await c.createWorkflowFromTemplate('webhook-to-log', 'demo');`,
  Python: `# pip install danax-sdk   (sau khi publish; dev: pip install -e packages/sdk-python)
from danax_sdk import DanaxClient

c = DanaxClient("http://localhost:8080")
login = c.login("demo@acme.local")
c.token = login["accessToken"]
print(c.list_orgs())
print(c.simulate([{"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}], "x:Y", "*"))`,
  Go: `// go get github.com/danax/danax-sdk-go  (sau khi repo public)
import danax "github.com/danax/danax-sdk-go"

c := danax.New("http://localhost:8080")
out, _ := c.Login("demo@acme.local")
c.Token = out["accessToken"].(string)
orgs, _ := c.ListOrgs()`,
  CLI: `# zero-dependency, chỉ cần Node 18+
node packages/cli/bin/olp.js login --email demo@acme.local
node packages/cli/bin/olp.js orgs
node packages/cli/bin/olp.js authz <uid> workflow:Execute "*" --context team=etl
node packages/cli/bin/olp.js workflows create --template webhook-to-log --name demo
node packages/cli/bin/olp.js audit --limit 20`,
};

export default function Docs() {
  const [tab, setTab] = useState('Console');
  return (
    <>
      <PageTitle title="Docs" sub="Hướng dẫn Console & SDK/CLI — song ngữ với thư mục docs/ trong repo" />
      <div className="flex gap-2 mb-4 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-2xl text-sm font-medium ${
              tab === t ? 'bg-gradient-to-b from-main-start to-main-end text-white' : 'bg-white text-normal-text shadow-sm'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <Card>
        <Code data={SNIPPETS[tab]} />
      </Card>
      <Card className="mt-4">
        <h3 className="font-semibold text-main-text mb-2">Tài liệu chi tiết trong repo</h3>
        <ul className="text-sm text-normal-text list-disc ml-5 space-y-1">
          <li><code>docs/quickstart.md</code> — chạy 3 lệnh, luồng đầu tiên</li>
          <li><code>docs/api.md</code> — API reference đầy đủ</li>
          <li><code>docs/iam-model.md</code> — mô hình phân quyền AWS-style</li>
          <li><code>docs/console.md</code> — vận hành Console</li>
          <li><code>docs/troubleshooting.md</code> + <code>docs/production.md</code></li>
        </ul>
      </Card>
    </>
  );
}
