#!/usr/bin/env bash
# Tao API key dau tien (prod da tat IAM_ALLOW_DEV_LOGIN): dung de dang nhap console
# bang tab "API Key". Chay tren server tu repo root:
#   bash tools/bootstrap-key.sh [email] [orgSlug]
# Chi in apiKey moi (luu ngay, hien 1 lan) — khong in secret nao khac.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi

DC="sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml"
if [ "$(id -u)" = "0" ]; then DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"; fi
if groups 2>/dev/null | grep -q '\bdocker\b'; then DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"; fi

EMAIL="${1:-admin@synapseone.space}"
ORG="${2:-${DEMO_ORG_SLUG:-acme}}"
INTERNAL="${SYNAPSEONE_INTERNAL_SECRET:?SYNAPSEONE_INTERNAL_SECRET rong — kiem tra .env}"
# Hex-only secret (da verify luc tao .env) -> noi vao JS an toan, khong can -e (tranh lo qua environ).
case "$INTERNAL$EMAIL$ORG" in
  *[\''"\\$`']*) echo "bootstrap: ky tu dac biet trong input — dung lai de kiem tra" >&2; exit 1 ;;
esac

# Goi truc tiep iam qua network noi bo (khong qua gateway), kem internal credential.
$DC exec -T iam node -e "
(async () => {
  const H = { 'Content-Type': 'application/json', 'x-synapseone-internal': '${INTERNAL}' };
  const base = 'http://localhost:4001';
  const email = '${EMAIL}', orgSlug = '${ORG}';
  let orgs = await (await fetch(base + '/v1/orgs', { headers: H })).json();
  let org = orgs.find(o => o.slug === orgSlug);
  if (!org) {
    const r = await fetch(base + '/v1/orgs', { method: 'POST', headers: H, body: JSON.stringify({ slug: orgSlug, displayName: orgSlug }) });
    org = await r.json();
  }
  await fetch(base + '/v1/orgs/' + org.id + '/users', { method: 'POST', headers: H, body: JSON.stringify({ email, displayName: email }) });
  let accs = await (await fetch(base + '/v1/orgs/' + org.id + '/accounts', { headers: H })).json();
  let acc = accs[0];
  if (!acc) {
    const r = await fetch(base + '/v1/orgs/' + org.id + '/accounts', { method: 'POST', headers: H, body: JSON.stringify({ slug: 'prod', displayName: 'prod' }) });
    acc = await r.json();
  }
  const r = await fetch(base + '/v1/accounts/' + acc.id + '/keys', { method: 'POST', headers: H, body: JSON.stringify({ name: 'bootstrap-admin', scopes: ['*'] }) });
  const k = await r.json();
  if (!k.apiKey) { console.error(JSON.stringify(k)); process.exit(1); }
  console.log('ORG=' + org.slug + ' ACCOUNT=' + acc.slug);
  console.log('API_KEY=' + k.apiKey);
})().catch(e => { console.error('bootstrap_failed', e.message); process.exit(1); });
"
