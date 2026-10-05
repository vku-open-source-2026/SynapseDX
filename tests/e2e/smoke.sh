#!/usr/bin/env bash
# OLP e2e smoke — chạy sau `docker compose up` hoặc dev local.
# Không fail-hard khi n8n/authentik chưa cấu hình: chỉ assert core IAM+gateway.
set -u
BASE="${OLP_BASE_URL:-http://localhost:8080}"
IAM_DIRECT="${IAM_URL:-http://localhost:4001}"
pass=0; fail=0
check() { # $1 name, $2... command
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS $name"; pass=$((pass+1)); else echo "FAIL $name"; fail=$((fail+1)); fi
}
echo "== OLP smoke vs $BASE =="
check gateway-health curl -sf "$BASE/health"
check iam-health curl -sf "$IAM_DIRECT/health"
# login dev
LOGIN_JSON=$(curl -s -XPOST "$BASE/v1/auth/login" -H'Content-Type: application/json' -d'{"email":"smoke@acme.local","orgSlug":"acme"}' || true)
echo "$LOGIN_JSON" | grep -q accessToken && { echo "PASS login"; pass=$((pass+1)); } || { echo "FAIL login: $LOGIN_JSON"; fail=$((fail+1)); }
TOK=$(echo "$LOGIN_JSON" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
if [ -n "${TOK:-}" ]; then
  check orgs-list curl -sf -H"Authorization: Bearer $TOK" "$BASE/v1/orgs"
  check templates curl -sf -H"Authorization: Bearer $TOK" "$BASE/v1/templates"
  # authorize self-test (userId từ login)
  UID=$(echo "$LOGIN_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
  if [ -n "${UID:-}" ]; then
    code=$(curl -s -o /tmp/authz.json -w "%{http_code}" -XPOST "$BASE/v1/authorize" -H'Content-Type: application/json' -H"Authorization: Bearer $TOK" -d"{\"userId\":\"$UID\",\"action\":\"workflow:Execute\",\"resource\":\"*\"}" || true)
    echo "authorize http=$code body=$(cat /tmp/authz.json 2>/dev/null)"
  fi
fi
echo "== result: pass=$pass fail=$fail =="
[ "$fail" -eq 0 ]
