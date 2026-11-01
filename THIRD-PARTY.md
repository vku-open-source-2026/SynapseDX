# Third-party components

This repository contains only project source under Apache-2.0. Dependencies are
installed unmodified from public registries; their upstream licenses remain in
the lockfile metadata and are not relicensed by VKU.VIC.

| Component family | License | Use |
|---|---|---|
| Node.js, TypeScript, Express, Zod, `@synapseone/sdk` | Apache-2.0/MIT/ISC/BSD | Tier-2 service and SDK |
| React, Vite, Tailwind, TanStack | MIT | Console build and UI |
| Leaflet, MapLibre, Turf | BSD-2-Clause/BSD-3-Clause/MIT | Maps and geospatial UI |

The release does not bundle `node_modules`; `npm ci` resolves the exact
versions recorded in `package-lock.json`. Run `npm ls --all` and inspect each
package metadata before changing dependencies. No GPL, AGPL, LGPL, SSPL,
RSAL, BUSL, Hippocratic, Commons-Clause, PolyForm, Elastic or other
source-available dependency is part of the release tree.
