#!/usr/bin/env bash
# Tao self-signed cert cho dev (olp.local). Production: thay bang cert LE/haproxy.
# Chay tu repo root: bash infra/tls/gen-cert.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR/certs"
export MSYS_NO_PATHCONV=1
KEYOUT="$(cygpath -w "$DIR/certs/olp.local.key")"
CRTOUT="$(cygpath -w "$DIR/certs/olp.local.crt")"
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout "$KEYOUT" \
  -out "$CRTOUT" \
  -subj "/CN=olp.local" \
  -addext "subjectAltName=DNS:olp.local,DNS:*.olp.local,DNS:localhost,IP:127.0.0.1"
echo "wrote $DIR/certs/olp.local.{crt,key}"
echo "tip: them '127.0.0.1 olp.local' vao hosts de mo https://olp.local"
