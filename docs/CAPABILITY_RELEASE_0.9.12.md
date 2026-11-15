# Capability expansion — 2026-11-16

Status: implementation in progress. This note is completed after the release
gate (tests, production deploy and read-only verification).

## Scope

Four Tier-2 capabilities close the generic connectors that the LCDP audit
previously listed as missing:

1. **Spatial record queries** — server-side `near`, `bbox` and `within` over a
   dataset's declared GeoJSON field, backed by SynapseBase PostGIS.
2. **Live capability events (SSE)** — a reconnectable `text/event-stream`
   projection over the Tier-1 stream, in addition to the existing cursor feed.
3. **Assignment optimization** — deterministic resource-to-demand matching with
   capacity, skills, distance/cost limits and explicit unassigned reasons.
4. **Plan orchestration** — phased plan templates, activation, dependency-aware
   task transitions, grounded briefs and AI-assisted drafts with deterministic
   fallback.

The capabilities are generic. City and SOS keep their domain policy, approval
rules and workflow ownership; they call these endpoints through the Tier-2 API
or SDK. No Tier-1 credential, database, queue or local fallback is introduced.

## Contracts

Filled from the merged implementation.

## Verification

Filled from the release gate.

## Boundaries and remaining work

Filled from the audit. Product-page adoption and business acceptance are
separate from capability availability.
