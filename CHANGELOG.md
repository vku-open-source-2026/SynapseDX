# Changelog

All notable changes to SynapseDX are documented here. Entries follow the
Keep a Changelog format and version tags use Semantic Versioning.

## [Unreleased] - 2026-11-04

- Added `PATCH /v1/capabilities/datasets/:id` and
  `CapabilitiesClient.datasets.update()` so dataset metadata (license,
  description, visibility, owner, schema version) can be migrated without
  recreating the dataset.

## [0.1.0] - 2026-11-01

- Published the public Tier-2 capabilities API and JavaScript SDK.
- Added Apache-2.0 licensing and VKU.VIC attribution.
