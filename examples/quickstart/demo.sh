#!/usr/bin/env bash
# Quickstart end-to-end: login -> org/account -> role/policy -> authorize -> workflow template
# Idempotent: chay lai lan 2 van OK (tai su dung tai nguyen da co khi gap 409).
set -euo pipefail
BASE="${OLP_BASE_URL:-http://localhost:8080}"
auth_h() { echo "Authorization: Bearer $TOK"; }

echo "== login =="
curl -s -XPOST "$BASE/v1/auth/login" -H'Content-Type: application/json' -d'{"email":"demo@acme.local","orgSlug":"acme"}' | tee /tmp/olp-login.json
TOK=$(jq -r .accessToken /tmp/olp-login.json)
UID=$(jq -r .user.id /tmp/olp-login.json)
echo; echo "== orgs =="
curl -s "$BASE/v1/orgs" -H"$(auth_h)" | tee /tmp/orgs.json; echo
ORG=$(jq -r '.[0].id' /tmp/orgs.json)
echo "ORG=$ORG UID=$UID"

echo "== account (tao neu chua co) =="
ACC_JSON=$(curl -s -XPOST "$BASE/v1/orgs/$ORG/accounts" -H'Content-Type: application/json' -H"$(auth_h)" -d'{"slug":"prod","displayName":"Production"}')
if echo "$ACC_JSON" | grep -q '"error":"conflict"'; then
  ACC=$(curl -s "$BASE/v1/orgs/$ORG/accounts" -H"$(auth_h)" | jq -r '.[] | select(.slug=="prod") | .id')
else
  ACC=$(echo "$ACC_JSON" | jq -r .id)
fi
echo "ACC=$ACC"

echo "== role + policy =="
ROLE_JSON=$(curl -s -XPOST "$BASE/v1/accounts/$ACC/roles" -H'Content-Type: application/json' -H"$(auth_h)" -d'{"slug":"runner"}')
ROLE=$(echo "$ROLE_JSON" | jq -r '.id // empty')
[ -z "$ROLE" ] && ROLE=$(curl -s "$BASE/v1/accounts/$ACC/roles" -H"$(auth_h)" | jq -r '.[] | select(.slug=="runner") | .id')
POL_JSON=$(curl -s -XPOST "$BASE/v1/accounts/$ACC/policies" -H'Content-Type: application/json' -H"$(auth_h)" -d'{"slug":"run-only","document":{"Version":"2026-01-01","Statement":[{"Effect":"Allow","Action":["workflow:Execute"],"Resource":"*"},{"Effect":"Deny","Action":["iam:*"],"Resource":"*"}]}}')
POL=$(echo "$POL_JSON" | jq -r '.id // empty')
[ -z "$POL" ] && POL=$(curl -s "$BASE/v1/accounts/$ACC/policies" -H"$(auth_h)" | jq -r '.[] | select(.slug=="run-only") | .id')
curl -s -XPOST "$BASE/v1/roles/$ROLE/attach" -H'Content-Type: application/json' -H"$(auth_h)" -d"{\"policyId\":\"$POL\"}"; echo
curl -s -XPOST "$BASE/v1/users/$UID/assign" -H'Content-Type: application/json' -H"$(auth_h)" -d"{\"roleId\":\"$ROLE\"}"; echo
echo "== authorize =="
curl -s -XPOST "$BASE/v1/authorize" -H'Content-Type: application/json' -H"$(auth_h)" -d"{\"userId\":\"$UID\",\"action\":\"workflow:Execute\",\"resource\":\"*\"}"; echo
echo "== api key =="
curl -s -XPOST "$BASE/v1/accounts/$ACC/keys" -H'Content-Type: application/json' -H"$(auth_h)" -d'{"name":"demo","scopes":["*"]}' | tee /tmp/key.json; echo
echo "== templates =="
curl -s "$BASE/v1/templates" -H"$(auth_h)"; echo
