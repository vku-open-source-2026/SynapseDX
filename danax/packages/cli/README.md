# `synapsedx` CLI — zero-dependency command line (Node 18+)

Apache-2.0. Part of [synapsedx](../../README.md) Tier-1 PaaS. No `npm install` needed —
single file, only Node's built-in `fetch`.

```bash
node packages/cli/bin/synapsedx.js --help
# hoặc link toàn cục:
npm link ./packages/cli   # rồi gọi `synapsedx ...` ở mọi nơi
```

## Nhanh

```bash
export SYNAPSEDX_BASE_URL=http://localhost:8080
synapsedx login --email demo@acme.local
synapsedx orgs
synapsedx accounts create prod Production
synapsedx authz <user-id> workflow:Execute "*" --context team=etl
synapsedx workflows create --template webhook-to-log --name demo
synapsedx audit --limit 20
```

## Quy ước
- Auth: `--base > $SYNAPSEDX_BASE_URL > ~/.synapsedx/config.json > http://localhost:8080`;
  token/key: `--token/--apikey > env > config`. `synapsedx login` / `synapsedx use-key` lưu vào
  `~/.synapsedx/config.json`.
- `--json` in raw JSON (script-friendly); mặc định in bảng gọn.
- Mọi lệnh đều gọi gateway (`/v1/*`) nên tôn trọng cùng auth/rate-limit.
