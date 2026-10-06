# `olp` CLI — zero-dependency command line (Node 18+)

Apache-2.0. Part of [OLP](../../README.md) Tier-1 PaaS. No `npm install` needed —
single file, only Node's built-in `fetch`.

```bash
node packages/cli/bin/olp.js --help
# hoặc link toàn cục:
npm link ./packages/cli   # rồi gọi `olp ...` ở mọi nơi
```

## Nhanh

```bash
export OLP_BASE_URL=http://localhost:8080
olp login --email demo@acme.local
olp orgs
olp accounts create prod Production
olp authz <user-id> workflow:Execute "*" --context team=etl
olp workflows create --template webhook-to-log --name demo
olp audit --limit 20
```

## Quy ước
- Auth: `--base > $OLP_BASE_URL > ~/.olp/config.json > http://localhost:8080`;
  token/key: `--token/--apikey > env > config`. `olp login` / `olp use-key` lưu vào
  `~/.olp/config.json`.
- `--json` in raw JSON (script-friendly); mặc định in bảng gọn.
- Mọi lệnh đều gọi gateway (`/v1/*`) nên tôn trọng cùng auth/rate-limit.
