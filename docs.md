# SynapseDX deployment and contracts

SynapseDX is a public HTTPS Tier-2 service. Put `apps/gateway` behind the
`synapsedx.sbs` TLS edge and proxy the public paths to host port 8082. The
gateway forwards to `apps/capabilities-service`; the frontend is
`apps/console`. The process
must be configured with a scoped SynapseOne API key (`SYNAPSEONE_API_KEY`) and
the public gateway URL `https://api.synapseone.space`.

The key is needed because capability metadata and private records are stored
in SynapseBase, which correctly requires an authenticated Tier-1 principal.
Public entity reads still go through the Tier-2 route and SynapseLDS public
visibility; the key remains server-side and is never returned to callers.

## Domain contract

| Operation | Tier-2 route | Tier-1 SDK operation |
| --- | --- | --- |
| dataset metadata | `/v1/capabilities/datasets` | `client.base.*` |
| public projection | `/v1/capabilities/datasets/:id/entities` | `client.lds.*` |
| capability event | internal to a write | `client.queue.publish()` |

`@synapseone/sdk` is a runtime dependency of `apps/capabilities-service`. The
service contains no direct `fetch` to SynapseOne and no private service URL.

## Operator actions

The operator must provide:

1. A scoped SynapseOne API key with access to Base, LDS, and Queue for the
   selected tenant/account.
2. A TLS reverse-proxy route for `synapsedx.sbs` to port 8082.
3. Registry access if `@synapsedx/capabilities` is to be published under the
   `@synapsedx` npm scope.
