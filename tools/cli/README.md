# `synapsedx` CLI — zero-dependency command line (Node 18+)

Apache-2.0. Part of [SynapseDX](../../README.md) Tier-1 PaaS. No `npm install` needed —
single file, only Node's built-in `fetch`.

```bash
node tools/cli/bin/synapsedx.js --help
# hoặc link toàn cục:
npm link ./tools/cli   # rồi gọi `synapsedx ...` ở mọi nơi
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
  `~/.synapsedx/config.json` (file 0600, secrets không bao giờ in ra — `config` redact).
- Ưu tiên env (`$SYNAPSEDX_TOKEN`, `$SYNAPSEDX_API_KEY`, `$SYNAPSEDX_REFRESH_TOKEN`) hoặc
  config hơn `--token/--apikey` trên dòng lệnh (flag lộ trong `ps`/shell history).
- Refresh token cũng được lưu (để `refresh` / `logout-all` dùng lại); cũng có thể truyền qua
  `$SYNAPSEDX_REFRESH_TOKEN`.
- `--json` in raw JSON (script-friendly); mặc định in bảng gọn.
- Mọi lệnh đều gọi gateway (`/v1/*`) nên tôn trọng cùng auth/rate-limit.
- Full lệnh: `login refresh logout-all verify use-key logout config whoami orgs accounts
  users roles policies attach assign authz sim audit keys sa workflows executions templates`
  (`synapsedx help`, xem `usage:` từng lệnh).
