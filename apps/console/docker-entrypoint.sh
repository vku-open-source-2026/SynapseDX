#!/bin/sh
# Inject runtime backend URL into config.js (build once, deploy anywhere).
# Escape sed-special chars in the env value so odd URLs can't break the substitution.
if [ -n "$SYNAPSEDX_PUBLIC_BASE_URL" ]; then
  ESCAPED_URL=$(printf '%s' "$SYNAPSEDX_PUBLIC_BASE_URL" | sed -e 's/[|\&\\]/\\&/g')
  sed -i "s|http://localhost:8080|${ESCAPED_URL}|g" /usr/share/nginx/html/config.js
fi
exec "$@"
