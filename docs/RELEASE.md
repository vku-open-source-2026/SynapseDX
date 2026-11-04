# Release and publish runbook

## SDK: `@synapsedx/capabilities`

The package is release-ready but **not published** from this workspace because
no `NPM_TOKEN` for the `@synapsedx` scope is available. Do not fake a release:
`npm view @synapsedx/capabilities version` must return the version before issue
#14 can close.

### What is verified locally

```bash
npm ci
npm run build --workspace=@synapsedx/capabilities
npm test --workspace=@synapsedx/capabilities

mkdir -p /tmp/sdk-pack
npm pack --workspace=@synapsedx/capabilities --pack-destination /tmp/sdk-pack
TARBALL=$(ls /tmp/sdk-pack/*.tgz)
tar -tzf "$TARBALL" | grep -E '(test|spec)\.(js|d\.ts)$' && exit 1 || true
tar -tzf "$TARBALL" | grep -q 'package/LICENSE'
tar -tzf "$TARBALL" | grep -q 'package/NOTICE'

mkdir -p /tmp/sdk-consumer && cd /tmp/sdk-consumer
npm init -y >/dev/null
npm install "$TARBALL"
node -e "const m=require('@synapsedx/capabilities'); if(typeof m.CapabilitiesClient!=='function') process.exit(1); console.log('sdk-ok')"
```

Expected tarball contents: `dist/index.js`, `dist/index.d.ts` (+ maps),
`README.md`, `LICENSE`, `NOTICE`, `package.json`. No test files, no `src/`.

### Operator publish step

1. Create an npm automation token with publish access to the `@synapsedx`
   scope.
2. Add it to the repository/environment as `NPM_TOKEN` (never commit it).
3. Tag `sdk-vX.Y.Z` or run the **Release SDK** workflow manually. The workflow
   builds/tests, re-checks the tarball, publishes with
   `--access public --provenance`, and skips publication with an explanation
   when `NPM_TOKEN` is absent.
4. Verify:
   ```bash
   npm view @synapsedx/capabilities version
   npm view @synapsedx/capabilities dist.tarball
   ```
5. Create the GitHub release `vX.Y.Z` with notes and the tarball/checksum.
6. Replace Tier-3 `file:` dependencies with the published semver range and
   rebuild from a standalone City/SOS clone.

The current package version is `0.3.0`; bump it with `npm version` before a new
tag. Publication (and therefore #14 closure) remains blocked on the operator
token.

## Temporary `@synapseone/sdk` vendor build

The published Tier-1 SDK `0.7.0` lacks `StorageService`,
`NotificationsService` and the typed identity/health lifecycle. Until a
registry release exists, `apps/capabilities-service` depends on
`vendor/synapseone-sdk-0.8.0-dev.0.tgz`, a build of the Apache-2.0 Tier-1 SDK
source with LICENSE/NOTICE and no test files.

Replacement procedure once `@synapseone/sdk@0.8.x` is published:

1. Change `apps/capabilities-service/package.json` to
   `"@synapseone/sdk": "^0.8.0"`.
2. Run `npm install` and refresh `package-lock.json`.
3. Remove `vendor/` and the `COPY vendor ./vendor` line from
   `apps/capabilities-service/Dockerfile`.
4. Run `npm run build`, `npm test`, `docker compose build` and update
   `THIRD-PARTY.md`/`README.md`.

The tarball is a temporary local dependency, not a fork: it is byte-for-byte
the Tier-1 SDK build and must not be patched independently.

## Service release

```bash
npm ci
npm run build
npm test
docker compose config
docker compose build
docker compose up -d
```

Tier-2 requires a scoped Tier-1 service credential with Base/LDS/Queue/Stream/
IAM/Workflow/Inference/Faststore/Storage/Notifications access. Local HTTP
dependencies are test-only (`ALLOW_LOCAL_DEPENDENCIES=true`); production must
use public HTTPS URLs.

## Container release (v* tags)

`.github/workflows/release-images.yml` builds and publishes:

```text
ghcr.io/vku-open-source-2026/synapsedx-capabilities:vX.Y.Z
ghcr.io/vku-open-source-2026/synapsedx-gateway:vX.Y.Z
ghcr.io/vku-open-source-2026/synapsedx-console:vX.Y.Z
```

Each image also gets `latest` and `sha-<commit>` tags. The GitHub release
attaches the verified SDK tarball, checksums, compose file and API/runner docs.
The separate operator-gated `sdk-v*` workflow publishes the npm SDK when
`NPM_TOKEN` is configured.
