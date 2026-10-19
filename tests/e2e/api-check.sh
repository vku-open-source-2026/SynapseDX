#!/usr/bin/env bash
# synapsedx full API check — bao phu toan bo IAM + workflow templates qua gateway.
# Yeu cau: gateway dang chay; SYNAPSEDX_BASE_URL (mac dinh http://localhost:8080).
# Tra ve exit 0 neu tat ca pass.
set -uo pipefail
BASE="${SYNAPSEDX_BASE_URL:-http://localhost:8080}"
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "PASS $1"; }
bad()  { fail=$((fail+1)); echo "FAIL $1 -- $2"; }

# Cho gateway + upstream san sang (cold boot docker co the mat 1-2 phut)
for i in $(seq 1 24); do
  curl -sf "$BASE/ready" >/dev/null 2>&1 && break
  sleep 5
done

LOGIN=$(curl -s -XPOST "$BASE/v1/auth/login" -H'Content-Type: application/json' -d'{"email":"e2e@acme.local","orgSlug":"acme"}')
TOK=$(echo "$LOGIN" | jq -r .accessToken)
E2E_UID=$(echo "$LOGIN" | jq -r .user.id)
if [ -n "${SYNAPSEDX_E2E_TOKEN:-}" ]; then
  # External mode (prod): dev login is disabled there, the caller mints a JWT.
  TOK="$SYNAPSEDX_E2E_TOKEN"; E2E_UID="external"
  ok login-external
else
  [ -n "$TOK" ] && [ "$TOK" != "null" ] && ok login || { bad login "$LOGIN"; exit 1; }
fi
H="Authorization: Bearer $TOK"
if [ "$E2E_UID" != "external" ]; then
  [ "$(curl -s "$BASE/v1/auth/me" -H"$H" | jq -r .user.email)" = "e2e@acme.local" ] && ok me || bad me ""
fi

if [ "$E2E_UID" = "external" ]; then
  true # IAM dev-seed flows need a real seeded identity — skipped in external mode
else
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
fi

# SynapseLDS: create -> schema (reserved rejected) -> ingest -> NGSI-LD export (no _core leak) -> delete
LDS=$(curl -s -XPOST "$BASE/v1/lds/datasources" -H'Content-Type: application/json' -H"$H" -d'{"name":"E2E Registry","entityType":"Organization","license":"CC-BY-4.0"}')
LDS_ID=$(echo "$LDS" | jq -r .id)
[ -n "$LDS_ID" ] && [ "$LDS_ID" != "null" ] && ok lds-create || bad lds-create "$LDS"
LDS_ATTR=$(curl -s -XPUT "$BASE/v1/lds/datasources/$LDS_ID/attributes" -H'Content-Type: application/json' -H"$H" -d'{"attributes":[{"name":"name","visibility":"public"},{"name":"taxCode","visibility":"restricted"}]}')
[ "$(echo "$LDS_ATTR" | jq 'length')" = "2" ] && ok lds-attributes || bad lds-attributes "$LDS_ATTR"
RES=$(curl -s -o /dev/null -w '%{http_code}' -XPUT "$BASE/v1/lds/datasources/$LDS_ID/attributes" -H'Content-Type: application/json' -H"$H" -d'{"attributes":[{"name":"internalId"}]}')
[ "$RES" = "400" ] && ok lds-reserved-rejected || bad lds-reserved-rejected "http=$RES"
ING=$(curl -s -XPOST "$BASE/v1/lds/datasources/$LDS_ID/records" -H'Content-Type: application/json' -H"$H" -d'{"id":"e2e-1","name":"E2E Co","tenantId":"evil","secretNote":"x"}')
[ "$(echo "$ING" | jq -r .ingested)" = "1" ] && [ "$(echo "$ING" | jq '.quarantined | length')" = "1" ] && ok lds-ingest || bad lds-ingest "$ING"
ENT=$(curl -s "$BASE/v1/lds/datasources/$LDS_ID/entities" -H"$H")
[ "$(echo "$ENT" | jq -r '.[0].id')" = "urn:ngsi-ld:Organization:e2e-1" ] && ok lds-export || bad lds-export "$ENT"
if echo "$ENT" | grep -qE 'tenantId|internalId|_core|secretNote'; then bad lds-no-leak "metadata leaked"; else ok lds-no-leak; fi
[ "$(curl -s -D- -o /dev/null "$BASE/v1/lds/datasources/$LDS_ID/entities" -H"$H" | grep -ci '^x-lds-license: CC-BY-4.0')" = "1" ] && ok lds-license-header || bad lds-license-header ""
# anonymous public channel: no token → public projection; management/writes → 401
ANON=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/lds/licenses")
[ "$ANON" = "200" ] && ok lds-anon-license || bad lds-anon-license "http=$ANON"
ANONEXP=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/lds/datasources/$LDS_ID/entities")
[ "$ANONEXP" = "200" ] && ok lds-anon-export || bad lds-anon-export "http=$ANONEXP"
ANONWR=$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/v1/lds/datasources/$LDS_ID/records" -H'Content-Type: application/json' -d'{"id":"evil"}')
[ "$ANONWR" = "401" ] && ok lds-anon-write-blocked || bad lds-anon-write-blocked "http=$ANONWR"
ANONRES=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/lds/datasources/$LDS_ID/entities?visibility=restricted")
[ "$ANONRES" = "401" ] && ok lds-anon-restricted-401 || bad lds-anon-restricted-401 "http=$ANONRES"
ANON404=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/lds/datasources/e2e-nope/entities")
[ "$ANON404" = "404" ] && ok lds-anon-unknown-404 || bad lds-anon-unknown-404 "http=$ANON404"
curl -s -XDELETE "$BASE/v1/lds/datasources/$LDS_ID" -H"$H" | grep -q '"ok":true' && ok lds-delete || bad lds-delete ""

# templates (built-in, khong can n8n) + request-id echo
[ "$(curl -s "$BASE/v1/templates" -H"$H" | jq 'length')" = "8" ] && ok templates || bad templates ""
[ -n "$(curl -s -D- -o /dev/null "$BASE/health" | grep -i '^x-request-id:')" ] && ok request-id || bad request-id ""

# negative / hardening checks (phai fail CLOSED)
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/orgs")" = "401" ] && ok anon-denied || bad anon-denied ""
if [ "$E2E_UID" = "external" ]; then
  # prod: dev login is disabled — the surface must still fail CLOSED (any 4xx)
  CX=$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/v1/auth/login" -H'Content-Type: application/json' -d'{"email":"not-an-email"}')
  case "$CX" in 4??) ok login-bad-email || true ;; *) bad login-bad-email "http=$CX" ;; esac
else
  [ "$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/v1/auth/login" -H'Content-Type: application/json' -d'{"email":"not-an-email"}')" = "400" ] && ok login-bad-email || bad login-bad-email ""
fi
[ "$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/v1/orgs" -H'Content-Type: application/json' -H"$H" -d'{"slug":"BAD SLUG!!","displayName":"x"}')" = "400" ] && ok org-bad-slug || bad org-bad-slug ""
if [ -n "${ACC:-}" ]; then
  [ "$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/v1/accounts/$ACC/policies" -H'Content-Type: application/json' -H"$H" -d'{"slug":"evil","document":{"Statement":[{"Effect":"Allow","Action":"'"$(printf 'x%.0s' $(seq 1 600))"'","Resource":"*"}]}}')" = "400" ] && ok policy-too-long || bad policy-too-long ""
fi
[ "$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/v1/roles/00000000-0000-0000-0000-000000000000/attach" -H'Content-Type: application/json' -H"$H" -d'{"policyId":"00000000-0000-0000-0000-000000000000"}')" = "404" ] && ok attach-404 || bad attach-404 ""
curl -s -D- -o /dev/null "$BASE/health" | grep -qi '^x-content-type-options: nosniff' && ok sec-headers || bad sec-headers ""
[ "$(curl -s -D- -o /dev/null "$BASE/health" | grep -ci '^x-powered-by:')" = "0" ] && ok no-powered-by || bad no-powered-by ""

echo "== result: pass=$pass fail=$fail =="
[ "$fail" -eq 0 ]
