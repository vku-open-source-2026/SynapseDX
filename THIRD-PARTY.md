# Third-party components

This repository contains only project source under Apache-2.0. Dependencies are
installed unmodified from public registries; their upstream licenses remain in
the lockfile metadata and are not relicensed by VKU.VIC.

The Tier-1 SDK is installed unmodified from the public npm registry as
`@synapseone/sdk@^0.8.0`; no vendored SDK tarball is used.

| Component | Version | License | Use |
|---|---|---|---|
| Node.js | 20+ | MIT-style | runtime for services and SDK |
| TypeScript | ^5.7.2 | Apache-2.0 | build-time compiler (all workspaces) |
| `@types/node` | ^22.10.2 | MIT | build-time types |
| `@types/express` | ^5.0.0 | MIT | build-time types |
| Express | ^4.21.2 | MIT | capabilities service and gateway HTTP boundary |
| `@synapseone/sdk` | ^0.8.0 (npm registry) | Apache-2.0 | Tier-1 Base/LDS/Queue/Stream/IAM/Workflow/Inference/Storage/Notifications access |
| nginx | 1.27-alpine | BSD-2-Clause | console static/proxy container |
| `nginx:1.27-alpine` base image packages | Alpine/musl/OpenSSL | MIT/BSD/Apache-2.0 | container runtime |

The console is plain static HTML/CSS/ES modules (no React, Vite, Tailwind,
TanStack, Leaflet, MapLibre or Turf dependency). Geocoding is not bundled: an
operator-configured external provider is called server-side only when
`SYNAPSEDX_GEOCODER_BASE_URL` is set.

The release does not bundle `node_modules`; `npm ci` resolves the exact
versions recorded in `package-lock.json`. Run `npm ls --all` and inspect each
package metadata before changing dependencies. No GPL, AGPL, LGPL, SSPL,
RSAL, BUSL, Hippocratic, Commons-Clause, PolyForm, Elastic or other
source-available dependency is part of the release tree.
