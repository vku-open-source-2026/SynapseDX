#!/usr/bin/env bash
# Xin cert Let's Encrypt lan dau cho synapseone.space (+cloud, +api) bang webroot.
# Chay tu repo root. Yeu cau: DNS 3 host -> IP server nay; port 80 public.
#   bash infra/prod/init-letsencrypt.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

DOMAIN="${DOMAIN:-synapseone.space}"
# Doc tu .env neu co (uu tien env hien tai)
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DOMAIN="${DOMAIN:-synapseone.space}"
LE_EMAIL="${LE_EMAIL:-hosybaonhan2004@gmail.com}"
STAGING="${STAGING:-0}"

DC="sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml"
if [ "$(id -u)" = "0" ]; then DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"; fi
# neu user trong group docker thi bo sudo
if groups 2>/dev/null | grep -q '\bdocker\b'; then DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"; fi

echo "[le] domain=${DOMAIN} email=${LE_EMAIL} staging=${STAGING}"
echo "[le] 1/4 build + up edge http-only (xin cert can :80)..."
$DC up -d --build nginx gateway console
sleep 8

ARGS="-d ${DOMAIN} -d cloud.${DOMAIN} -d api.${DOMAIN}"
if [ "$STAGING" = "1" ]; then ARGS="$ARGS --staging"; fi

echo "[le] 2/4 certonly webroot..."
$DC run --rm certbot certonly --webroot -w /var/www/certbot \
  --email "$LE_EMAIL" --agree-tos --no-eff-email --keep-until-expiring \
  $ARGS

echo "[le] 3/4 restart nginx len full-https..."
$DC restart nginx
sleep 5

echo "[le] 4/4 kiem tra..."
curl -sk -o /dev/null -w "cloud: %{http_code}\n" "https://cloud.${DOMAIN}/config.js" || true
curl -sk -o /dev/null -w "root : %{http_code}\n" "https://${DOMAIN}/" || true
curl -sk -o /dev/null -w "api  : %{http_code}\n" "https://api.${DOMAIN}/health" || true
echo "[le] renew dinh ky: them cron: 0 3 * * * /home/$(whoami)/SynapseOne/infra/prod/renew.sh"
