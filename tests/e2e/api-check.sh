#!/usr/bin/env bash
# OLP full API check — bao phu toan bo IAM + workflow templates qua gateway.
# Yeu cau: gateway dang chay; OLP_BASE_URL (mac dinh http://localhost:8080).
# Tra ve exit 0 neu tat ca pass.
set -uo pipefail
BASE="${OLP_BASE_URL:-http://localhost:8080}"
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "PASS $1"; }
bad()  { fail=$((fail+1)); echo "FAIL $1 -- $2"; }

LOGIN=$(curl -s -XPOST "$BASE/v1/auth/login" -H'Content-Type: application/json' -d'{"email":"e2e@acme.local","orgSlug":"acme"}')
TOK=$(echo "$LOGIN" | jq -r .accessToken)
E2E_UID=$(echo "$LOGIN" | jq -r .user.id)
[ -n "$TOK" ] && [ "$TOK" != "null" ] && ok login || { bad login "$LOGIN"; exit 1; }
H="Authorization: Bearer $TOK"
[ "$(curl -s "$BASE/v1/auth/me" -H"$H" | jq -r .user.email)" = "e2e@acme.local" ] && ok me || bad me ""

# health + ready + metrics (public)
curl -sf "$BASE/health" >/dev/null && ok health || bad health ""
[ -n "$(curl -s "$BASE/health" | jq -r .version)" ] && ok version || bad version ""
curl -sf "$BASE/ready" >/dev/null && ok ready || bad ready ""
curl -sf "$BASE/metrics" | grep -q gateway_requests_total && ok metrics || bad metrics ""

# orgs/accounts/users
ORG=$(curl -s "$BASE/v1/orgs" -H"$H" | jq -r '.[0].id')
ACC=$(curl -s -XPOST "$BASE/v1/orgs/$ORG/accounts" -H'Content-Type: application/json' -H"$H" -d'{"slug":"e2e","displayName":"E2E"}' | jq -r .id)
[ -n "$ACC" ] && [ "$ACC" != "null" ] && ok account || bad account ""
[ "$(curl -s "$BASE/v1/orgs/$ORG/users" -H"$H" | jq 'length')" -ge 1 ] && ok users-list || bad users-list ""

# roles/policies/attach/assign/authorize(+conditions)/dry-run/delete
ROLE=$(curl -s -XPOST "$BASE/v1/accounts/$ACC/roles" -H'Content-Type: application/json' -H"$H" -d'{"slug":"r"}' | jq -r .id)
POL=$(curl -s -XPOST "$BASE/v1/accounts/$ACC/policies" -H'Content-Type: application/json' -H"$H" -d'{"slug":"p","document":{"Version":"2026-01-01","Statement":[{"Effect":"Allow","Action":["t:Act"],"Resource":"*","Condition":{"StringEquals":{"team":"etl"}}}]}}' | jq -r .id)
curl -s -XPOST "$BASE/v1/roles/$ROLE/attach" -H'Content-Type: application/json' -H"$H" -d"{\"policyId\":\"$POL\"}" | grep -q '"ok":true' && ok attach || bad attach ""
curl -s -XPOST "$BASE/v1/users/$E2E_UID/assign" -H'Content-Type: application/json' -H"$H" -d"{\"roleId\":\"$ROLE\"}" | grep -q '"ok":true' && ok assign || bad assign ""
[ "$(curl -s -XPOST "$BASE/v1/authorize" -H'Content-Type: application/json' -H"$H" -d"{\"userId\":\"$E2E_UID\",\"action\":\"t:Act\",\"resource\":\"*\",\"context\":{\"team\":\"etl\"}}" | jq -r .allowed)" = "true" ] && ok authz-allow || bad authz-allow ""
[ "$(curl -s -XPOST "$BASE/v1/authorize" -H'Content-Type: application/json' -H"$H" -d"{\"userId\":\"$E2E_UID\",\"action\":\"t:Act\",\"resource\":\"*\",\"context\":{\"team\":\"x\"}}" | jq -r .allowed)" = "false" ] && ok authz-deny || bad authz-deny ""
[ "$(curl -s -XPOST "$BASE/v1/authorize/dry-run" -H'Content-Type: application/json' -H"$H" -d'{"documents":[{"Statement":[{"Effect":"Allow","Action":"a","Resource":"*"}]}],"action":"a","resource":"*"}' | jq -r .allowed)" = "true" ] && ok dryrun || bad dryrun ""
[ "$(curl -s "$BASE/v1/audit?limit=3" -H"$H" | jq 'length')" -ge 1 ] && ok audit || bad audit ""
curl -s -XDELETE "$BASE/v1/roles/$ROLE" -H"$H" | grep -q '"ok":true' && ok role-del || bad role-del ""

# keys lifecycle: create -> verify -> revoke -> verify-invalid
KEY_JSON=$(curl -s -XPOST "$BASE/v1/accounts/$ACC/keys" -H'Content-Type: application/json' -H"$H" -d'{"name":"e2e"}')
KID=$(echo "$KEY_JSON" | jq -r .id); KVAL=$(echo "$KEY_JSON" | jq -r .apiKey)
[ "$(curl -s -XPOST "$BASE/v1/keys/verify" -H'Content-Type: application/json' -H"$H" -d"{\"apiKey\":\"$KVAL\"}" | jq -r .valid)" = "true" ] && ok key-verify || bad key-verify ""
curl -s -XDELETE "$BASE/v1/keys/$KID" -H"$H" | grep -q '"ok":true' && ok key-revoke || bad key-revoke ""
[ "$(curl -s -XPOST "$BASE/v1/keys/verify" -H'Content-Type: application/json' -H"$H" -d"{\"apiKey\":\"$KVAL\"}" | jq -r .valid)" = "false" ] && ok key-dead || bad key-dead ""

# service account token + refresh rotation + logout
SA=$(curl -s -XPOST "$BASE/v1/accounts/$ACC/service-accounts" -H'Content-Type: application/json' -H"$H" -d'{"slug":"sa"}' | jq -r .id)
[ "$(curl -s -XPOST "$BASE/v1/service-accounts/$SA/token" -H'Content-Type: application/json' -H"$H" -d'{}' | jq -r .accessToken | cut -c1-10)" != "null" ] && ok sa-token || bad sa-token ""
RT1=$(echo "$LOGIN" | jq -r .refreshToken)
RT2=$(curl -s -XPOST "$BASE/v1/auth/refresh" -H'Content-Type: application/json' -d"{\"refreshToken\":\"$RT1\"}" | jq -r .refreshToken)
[ -n "$RT2" ] && [ "$RT2" != "null" ] && [ "$RT2" != "$RT1" ] && ok rotation || bad rotation ""
curl -s "$BASE/v1/auth/refresh" -XPOST -H'Content-Type: application/json' -d"{\"refreshToken\":\"$RT1\"}" | grep -q invalid_refresh && ok rotation-single-use || bad rotation-single-use ""
curl -s -XPOST "$BASE/v1/auth/logout" -H'Content-Type: application/json' -d"{\"refreshToken\":\"$RT2\"}" | grep -q '"ok":true' && ok logout || bad logout ""

# templates (built-in, khong can n8n) + request-id echo
[ "$(curl -s "$BASE/v1/templates" -H"$H" | jq 'length')" = "3" ] && ok templates || bad templates ""
[ -n "$(curl -s -D- -o /dev/null "$BASE/health" | grep -i '^x-request-id:')" ] && ok request-id || bad request-id ""

echo "== result: pass=$pass fail=$fail =="
[ "$fail" -eq 0 ]
