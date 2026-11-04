# Vendored Tier-1 SDK (temporary)

`synapseone-sdk-0.8.0-dev.0.tgz` is the compiled JavaScript/TypeScript build of
the Apache-2.0 SynapseOne SDK (`SynapseOne/sdks/sdk-js`) from the 2026-11-04
workspace state. It exists only because the registry release
`@synapseone/sdk@0.7.0` predates:

- `StorageService` (binary objects, presign, checksum, quota),
- `NotificationsService` (outbox/templates/preferences),
- the typed health/ready and identity lifecycle methods.

Artifact:

- name: `synapseone-sdk-0.8.0-dev.0.tgz`
- sha256: `b8ec994555f1d146c63b5bbadbc5c7d32ae0e9f7ef775b45caa59543906df88d`
- contents: `dist/*.js`, `dist/*.d.ts`, `LICENSE`, `NOTICE`, `README.md`,
  `package.json` (no tests/example artifacts).

`apps/capabilities-service/package.json` pins it as
`file:../../vendor/synapseone-sdk-0.8.0-dev.0.tgz`; the Docker build copies
`vendor/` into the build context. Do not patch the tarball: rebuild it from the
Tier-1 SDK source or, preferably, replace it with the published
`@synapseone/sdk@^0.8.0`.

Replacement steps: [`../docs/RELEASE.md`](../docs/RELEASE.md).
