#!/usr/bin/env bash
# DEPRECATED: n8n removed in 0.4.0 — workflow-service now runs its own local
# engine (no API key, no owner setup). This script stays as a no-op stub so old
# docs/aliases fail loudly instead of half-working.
echo "tools/setup-n8n.sh is deprecated: local workflow engine needs no n8n setup (see docs/quickstart.md #5)." >&2
exit 2
