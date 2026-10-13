#!/usr/bin/env bash
# Tao self-signed cert cho dev (synapsedx.local). Production: thay bang cert LE/haproxy.
# Chay tu repo root: bash infra/tls/gen-cert.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR/certs"
export MSYS_NO_PATHCONV=1
# Portable: prefer plain paths (Linux/macOS); only use cygpath on Git-Bash/Cygwin.
if command -v cygpath >/dev/null 2>&1; then
  KEYOUT="$(cygpath -w "$DIR/certs/synapsedx.local.key")"
  CRTOUT="$(cygpath -w "$DIR/certs/synapsedx.local.crt")"
else
  KEYOUT="$DIR/certs/synapsedx.local.key"
  CRTOUT="$DIR/certs/synapsedx.local.crt"
fi
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout "$KEYOUT" \
  -out "$CRTOUT" \
  -subj "/CN=synapsedx.local" \
  -addext "subjectAltName=DNS:synapsedx.local,DNS:*.synapsedx.local,DNS:localhost,IP:127.0.0.1"
echo "wrote $DIR/certs/synapsedx.local.{crt,key}"
echo "tip: them '127.0.0.1 synapsedx.local' vao hosts de mo https://synapsedx.local"
