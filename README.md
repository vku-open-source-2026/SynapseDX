# SynapseDX — Tier 2

SynapseDX is split into independently deployable product parts:

```text
apps/gateway             public HTTPS API boundary (port 8080)
apps/capabilities-service reusable capability backend (port 8082)
apps/console              static frontend shell
sdks/capabilities-js      @synapsedx/capabilities client SDK
infra/                    public-edge snippets and deployment material
```

The backend imports the published `@synapseone/sdk@0.7.0`; it does not use raw
HTTP to SynapseOne. The gateway only proxies the Tier-2 API within the product.
Tier 3 calls the gateway at `https://synapsedx.sbs`.

```bash
cp .env.example .env
npm install
npm test
npm run build
docker compose up -d --build
```

The public edge must route `synapsedx.sbs` to the gateway and an optional
`cloud.synapsedx.sbs` to the console. See `infra/nginx/synapsedx.conf`.

## PoF project checklist

- License: Apache-2.0 (`LICENSE`) with per-source SPDX headers and attribution in `NOTICE`.
- Build from source: `npm ci && npm run build` using Node.js 20+; Docker builds are reproducible with `docker compose build`.
- Issue tracker: [GitHub Issues](https://github.com/vku-open-source-2026/SynapseDX/issues).
- Change history: [`CHANGELOG.md`](CHANGELOG.md). Versioned release tags are published on GitHub.
- Dependency inventory: [`THIRD-PARTY.md`](THIRD-PARTY.md); dependencies are not modified or bundled into the repository.
