# `danax` CLI — zero-dependency command line (Node 18+)

Apache-2.0. Part of [danax](../../README.md) Tier-1 PaaS. No `npm install` needed —
single file, only Node's built-in `fetch`.

```bash
node packages/cli/bin/danax.js --help
# hoặc link toàn cục:
npm link ./packages/cli   # rồi gọi `danax ...` ở mọi nơi
```

## Nhanh

```bash
export DANAX_BASE_URL=http://localhost:8080
danax login --email demo@acme.local
danax orgs
danax accounts create prod Production
danax authz <user-id> workflow:Execute "*" --context team=etl
danax workflows create --template webhook-to-log --name demo
danax audit --limit 20
```

## Quy ước
- Auth: `--base > $DANAX_BASE_URL > ~/.danax/config.json > http://localhost:8080`;
  token/key: `--token/--apikey > env > config`. `danax login` / `danax use-key` lưu vào
  `~/.danax/config.json`.
- `--json` in raw JSON (script-friendly); mặc định in bảng gọn.
- Mọi lệnh đều gọi gateway (`/v1/*`) nên tôn trọng cùng auth/rate-limit.
