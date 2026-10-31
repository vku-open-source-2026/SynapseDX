#!/bin/sh
# SynapseOne CLI one-line installer (POSIX sh, no dependencies besides Node 18+).
#   curl -fsSL https://synapseone.space/install.sh | sh
#   # or pin a version: CLI_VERSION=0.7.0 curl -fsSL https://synapseone.space/install.sh | sh
# What it does: checks for node >= 18, then `npm install -g @synapseone/cli[@version]`.
# No shell profiles are modified. Uninstall: `npm uninstall -g @synapseone/cli`.
# Mirror: this file is the canonical source; apps/console/public/install.sh is a
# byte-identical copy served by the web frontend — keep them in sync.
set -eu

PKG="@synapseone/cli"
VERSION="${CLI_VERSION:-latest}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "install: '$1' not found." >&2
    return 1
  fi
}

if ! need node; then
  echo "install: Node.js 18+ is required: https://nodejs.org/en/download" >&2
  exit 1
fi
if ! need npm; then
  echo "install: npm is required (it ships with Node.js): https://nodejs.org/en/download" >&2
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "install: Node.js 18+ is required (found $(node -v)). Upgrade: https://nodejs.org/en/download" >&2
  exit 1
fi

echo "install: installing ${PKG}@${VERSION} ..."
# shellcheck disable=SC2086
npm install -g ${PKG}@${VERSION}

if ! command -v synapseone >/dev/null 2>&1; then
  echo "install: done, but 'synapseone' is not on PATH." >&2
  echo "install: add npm's global bin dir to PATH, e.g.: export PATH=\"\$(npm config get prefix)/bin:\$PATH\"" >&2
  exit 1
fi

echo "install: OK — $(synapseone --help 2>/dev/null | head -n 1)"
echo "install: next: synapseone login --base https://api.synapseone.space --email you@example.com"
