#!/bin/sh
# Inject runtime backend URL into config.js (build once, deploy anywhere).
if [ -n "$DANAX_PUBLIC_BASE_URL" ]; then
  sed -i "s|http://localhost:8080|${DANAX_PUBLIC_BASE_URL}|g" /usr/share/nginx/html/config.js
fi
exec "$@"
