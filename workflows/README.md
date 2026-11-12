# SynapseDX workflows (git-managed)

`mcp-docs-reader.json` is the canonical text of the SynapseDX docs-reader
workflow. Edit this file in git; do not edit the deployed copy by hand.

- Tier: SynapseDX (Tier 2). Provision it through the capabilities service using
  the Tier-1 SDK (`client.workflow.createWorkflow`/`activateWorkflow`) — never
  by calling SynapseOne directly from Tier-3 code.
- Trigger: `mcpTrigger` tool `read_synapsedx_docs`.
- The workflow reads `docs/API.md` (override with `{"path":"..."}`) from
  `raw.githubusercontent.com/vku-open-source-2026/SynapseDX/main/...`.
- Activate the workflow; it is then exposed by the SynapseOne MCP endpoint
  `POST https://api.synapseone.space/mcp` with a Bearer JWT or `X-API-Key`.

CI should validate the JSON (`node -e "JSON.parse(...)"`) before deployment.
