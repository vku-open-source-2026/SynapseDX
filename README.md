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
