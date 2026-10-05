#!/usr/bin/env bash
# Quickstart end-to-end: login -> org/account -> role/policy -> authorize -> workflow template
set -euo pipefail
BASE="${OLP_BASE_URL:-http://localhost:8080}"
echo "== login =="
curl -s -XPOST "$BASE/v1/auth/login" -H'Content-Type: application/json' -d'{"email":"demo@acme.local","orgSlug":"acme"}' | tee /tmp/olp-login.json
TOK=$(jq -r .accessToken /tmp/olp-login.json)
UID=$(jq -r .user.id /tmp/olp-login.json)
echo; echo "== orgs =="
curl -s "$BASE/v1/orgs" -H"Authorization: Bearer $TOK" | tee /tmp/orgs.json; echo
ORG=$(jq -r '.[0].id' /tmp/orgs.json)
echo "ORG=$ORG UID=$UID"
echo "== create account =="
curl -s -XPOST "$BASE/v1/orgs/$ORG/accounts" -H'Content-Type: application/json' -H"Authorization: Bearer $TOK" -d'{"slug":"prod","displayName":"Production"}' | tee /tmp/acc.json; echo
ACC=$(jq -r .id /tmp/acc.json)
echo "== role + policy =="
ROLE=$(curl -s -XPOST "$BASE/v1/accounts/$ACC/roles" -H'Content-Type: application/json' -H"Authorization: Bearer $TOK" -d'{"slug":"runner"}' | jq -r .id)
POL=$(curl -s -XPOST "$BASE/v1/accounts/$ACC/policies" -H'Content-Type: application/json' -H"Authorization: Bearer $TOK" -d'{"slug":"run-only","document":{"Version":"2026-01-01","Statement":[{"Effect":"Allow","Action":["workflow:Execute"],"Resource":"*"},{"Effect":"Deny","Action":["iam:*"],"Resource":"*"}]}}' | jq -r .id)
curl -s -XPOST "$BASE/v1/roles/$ROLE/attach" -H'Content-Type: application/json' -H"Authorization: Bearer $TOK" -d"{\"policyId\":\"$POL\"}"; echo
curl -s -XPOST "$BASE/v1/users/$UID/assign" -H'Content-Type: application/json' -H"Authorization: Bearer $TOK" -d"{\"roleId\":\"$ROLE\"}"; echo
echo "== authorize =="
curl -s -XPOST "$BASE/v1/authorize" -H'Content-Type: application/json' -H"Authorization: Bearer $TOK" -d"{\"userId\":\"$UID\",\"action\":\"workflow:Execute\",\"resource\":\"*\"}"; echo
echo "== api key =="
curl -s -XPOST "$BASE/v1/accounts/$ACC/keys" -H'Content-Type: application/json' -H"Authorization: Bearer $TOK" -d'{"name":"demo","scopes":["*"]}' | tee /tmp/key.json; echo
echo "== templates =="
curl -s "$BASE/v1/templates" -H"Authorization: Bearer $TOK"; echo
