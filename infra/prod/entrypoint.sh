#!/bin/sh
# Render nginx conf tu template (thay @@DOMAIN@@) roi chon full-https hay http-only
# tuy cert LE da ton tai chua. Chay trong container nginx (alpine/busybox sh).
set -eu
DOMAIN="${DOMAIN:-synapsedx.sbs}"
CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
mkdir -p /etc/nginx/conf.d
# thay the an toan: DOMAIN chi chua [a-z0-9.-] (validate truoc khi sed)
case "$DOMAIN" in
  *[!a-zA-Z0-9.-]*)
    echo "[edge] DOMAIN khong hop le: $DOMAIN" >&2
    exit 1
    ;;
esac
if [ -f "$CERT" ]; then
  sed "s/@@DOMAIN@@/${DOMAIN}/g" /templates/nginx-prod.conf > /etc/nginx/conf.d/default.conf
  echo "[edge] TLS full cho ${DOMAIN} (+cloud, +api)"
else
  sed "s/@@DOMAIN@@/${DOMAIN}/g" /templates/nginx-http-only.conf > /etc/nginx/conf.d/default.conf
  echo "[edge] CHUA co cert ${CERT} — chay http-only de certbot xin cert"
fi
nginx -t
exec nginx -g "daemon off;"
