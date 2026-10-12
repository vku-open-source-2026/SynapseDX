#!/usr/bin/env bash
# Renew cert (chay cron moi ngay 3h): renew + reload nginx neu cert doi.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DC="sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml"
if [ "$(id -u)" = "0" ]; then DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"; fi
if groups 2>/dev/null | grep -q '\bdocker\b'; then DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"; fi
$DC run --rm certbot renew --quiet
$DC exec nginx nginx -s reload
echo "[le] renewed + reloaded $(date -u +%FT%TZ)"
