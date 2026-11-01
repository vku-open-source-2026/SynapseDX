# SynapseDX — Tier 2 capabilities

SynapseDX is the reusable capability layer. It is not a replacement platform
and it is not a domain application. It exposes generic organization/open-data
capabilities and uses SynapseOne for all persistence and messaging.

The repository is intentionally split like SynapseOne:

- `apps/gateway`: public API boundary;
- `apps/capabilities-service`: backend capability service;
- `apps/console`: frontend shell;
- `sdks/capabilities-js`: published Tier-2 SDK;
- `infra`: edge/deployment files.

## Dependency contract

- Import `@synapseone/sdk`; do not use raw HTTP to SynapseOne.
- Default Tier-1 URL is `https://api.synapseone.space` (the public
  `synapseone.space` domain). Set `SYNAPSEONE_BASE_URL` only to another public
  HTTPS gateway in a deployment. Local URLs are rejected unless an explicit
  test-only override is set.
- The service API key or caller bearer token is forwarded to SynapseOne. The
  Tier-2 process never stores a second database or queue.
- `sdks/capabilities-js/` is the Tier-2 client consumed by SynapseCity. Its default API URL
  is `https://synapsedx.sbs`.

## Capabilities

The initial API provides generic datasets, records, public publication through
SynapseLDS, and an event queue. Domain fields stay in the record payload; no
OpenInfra-specific rule belongs here.

## Commands

```bash
npm install
npm run build
npm test
npm start
```
