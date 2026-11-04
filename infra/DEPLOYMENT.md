# Public deployment

The stack has three containers: `capabilities` (backend, §8082), `gateway`
(public API, container §8080, host §8082) and `console` (frontend, §80). The
gateway calls the backend over the Tier-2 stack network (`capabilities:8082`);
Tier 2 calls SynapseOne only through `https://api.synapseone.space`.

Compose uses this repository as the Docker build context and defines
healthchecks plus `depends_on` ordering: capabilities → gateway → console. The
containers receive network aliases `synapsedx-gateway` and
`synapsedx-console`.

The existing SynapseOne edge container is on a different Docker network. After
starting this stack, connect that edge to this network and include
`nginx/synapsedx.conf`:

```bash
docker network connect synapsedx-public-stack synapseone-nginx-1
```

Issue a certificate containing `synapsedx.sbs` (and the optional
`cloud.synapsedx.sbs`) before enabling the TLS server block. The DNS A/AAAA
records must point to this host.

Before `docker compose up`, provide:

- `SYNAPSEONE_API_KEY` (or `SYNAPSEONE_TOKEN`) — a scoped Tier-1 credential with
  Base, LDS, Queue, Stream, IAM, Workflow, Inference and Faststore access;
- `CORS_ORIGINS` — the exact browser origins for City, SOS and the console;
- optionally `SYNAPSEDX_GEOCODER_*` for the geocoding adapter.

Verify the deployment:

```bash
docker compose config
docker compose build
docker run --rm synapsedx-console nginx -t
curl -fsS https://synapsedx.sbs/v1/capabilities/health
curl -fsS https://synapsedx.sbs/v1/capabilities/ready
```

`/ready` returns 503 when a critical Tier-1 dependency (Base, LDS, Queue) is
down; the payload names each dependency with status, latency and error code.
