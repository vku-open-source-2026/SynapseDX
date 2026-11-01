# Public deployment

The stack has three containers: `capabilities` (backend), `gateway` (public
API), and `console` (frontend). The gateway is published on host port `8082`.
It calls the backend over the Tier-2 stack network; Tier 2 calls SynapseOne
only through `https://api.synapseone.space`.

The existing SynapseOne edge container is on a different Docker network. After
starting this stack, connect that edge to this network and include
`nginx/synapsedx.conf`:

```bash
docker network connect synapsedx-public-stack synapseone-nginx-1
```

Issue a certificate containing `synapsedx.sbs` (and the optional
`cloud.synapsedx.sbs`) before enabling the TLS server block. The DNS A/AAAA
records must point to this host. The capabilities service also needs a scoped
`SYNAPSEONE_API_KEY` in `.env`.
