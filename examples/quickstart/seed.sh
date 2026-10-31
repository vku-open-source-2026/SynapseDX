#!/usr/bin/env bash
# Seed du lieu mau cho synapseone: org demo + accounts + roles/policies/users + api key.
# Idempotent (chay lai an toan). Yeu cau: gateway dang chay, jq co san.
set -uo pipefail
BASE="${SYNAPSEONE_BASE_URL:-http://localhost:8080}"
ORGSLUG="${SEED_ORG:-demo}"
EMAIL="${SEED_EMAIL:-admin@demo.local}"

LOGIN=$(curl -s -XPOST "$BASE/v1/auth/login" -H'Content-Type: application/json' -d"{\"email\":\"$EMAIL\",\"orgSlug\":\"$ORGSLUG\"}")
TOK=$(echo "$LOGIN" | jq -r .accessToken)
UID=$(echo "$LOGIN" | jq -r .user.id)
H="Authorization: Bearer $TOK"

ORG=$(curl -s "$BASE/v1/orgs" -H"$H" | jq -r '.[0].id')
echo "ORG=$ORG"

for ACC in prod staging; do
  R=$(curl -s -XPOST "$BASE/v1/orgs/$ORG/accounts" -H'Content-Type: application/json' -H"$H" -d"{\"slug\":\"$ACC\",\"displayName\":\"$ACC\"}")
  AID=$(echo "$R" | jq -r '.id // empty')
  if [ -z "$AID" ] || [ "$AID" = "null" ]; then
    AID=$(curl -s "$BASE/v1/orgs/$ORG/accounts" -H"$H" | jq -r ".[] | select(.slug==\"$ACC\") | .id")
  fi
  echo "ACCOUNT $ACC=$AID"
  for RNAME in viewer etl-runner; do
    curl -s -XPOST "$BASE/v1/accounts/$AID/roles" -H'Content-Type: application/json' -H"$H" -d"{\"slug\":\"$RNAME\"}" >/dev/null || true
  done
  curl -s -XPOST "$BASE/v1/accounts/$AID/policies" -H'Content-Type: application/json' -H"$H" \
    -d'{"slug":"viewer-read","document":{"Version":"2026-01-01","Statement":[{"Effect":"Allow","Action":["*:Get","*:List","*:Read"],"Resource":"*"}]}}' >/dev/null || true
  curl -s -XPOST "$BASE/v1/accounts/$AID/policies" -H'Content-Type: application/json' -H"$H" \
    -d'{"slug":"etl-run","document":{"Version":"2026-01-01","Statement":[{"Effect":"Allow","Action":["workflow:Execute","workflow:Read"],"Resource":"*"},{"Effect":"Deny","Action":["iam:*"],"Resource":"*"}]}}' >/dev/null || true
  RID=$(curl -s "$BASE/v1/accounts/$AID/roles" -H"$H" | jq -r '.[] | select(.slug=="viewer") | .id')
  PID=$(curl -s "$BASE/v1/accounts/$AID/policies" -H"$H" | jq -r '.[] | select(.slug=="viewer-read") | .id')
  curl -s -XPOST "$BASE/v1/roles/$RID/attach" -H'Content-Type: application/json' -H"$H" -d"{\"policyId\":\"$PID\"}" >/dev/null || true
  curl -s -XPOST "$BASE/v1/users/$UID/assign" -H'Content-Type: application/json' -H"$H" -d"{\"roleId\":\"$RID\"}" >/dev/null || true
done
echo "SEED_OK org=$ORGSLUG email=$EMAIL"
