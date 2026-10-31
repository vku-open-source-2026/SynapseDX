#!/bin/sh
# Inject runtime URLs into config.js (build once, deploy anywhere).
# - SYNAPSEONE_PUBLIC_BASE_URL: gateway API ma TRINH DUYET goi toi (https://api.* o prod).
# - CONSOLE_APP_URL: canonical app host (https://cloud.* o prod). Web chinh (@)
#   dung gia tri nay de redirect nut Dang nhap / Mo Console ve cloud.
# Escape sed-special chars (| & \ and ') so odd URLs can't break the substitution
# or inject JS into config.js.
if [ -n "$SYNAPSEONE_PUBLIC_BASE_URL" ]; then
  ESCAPED_URL=$(printf '%s' "$SYNAPSEONE_PUBLIC_BASE_URL" | sed -e "s/[|&\\\\]/\\\\&/g" -e "s/'/'\\\\''/g")
  sed -i "s|http://localhost:8080|${ESCAPED_URL}|g" /usr/share/nginx/html/config.js
fi
if [ -n "$CONSOLE_APP_URL" ]; then
  ESCAPED_APP=$(printf '%s' "$CONSOLE_APP_URL" | sed -e "s/[|&\\\\]/\\\\&/g" -e "s/'/'\\\\''/g")
  sed -i "s|http://localhost:3000|${ESCAPED_APP}|g" /usr/share/nginx/html/config.js
fi
exec "$@"
