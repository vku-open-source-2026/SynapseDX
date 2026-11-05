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

## Tier-1 SDK dependency

`apps/capabilities-service` installs `@synapseone/sdk@^0.8.0` from the public npm
registry. The SDK includes SynapseOCS/storage, notifications and the typed
identity/health lifecycle. There is no vendored SDK tarball and no `file:`
dependency; Docker builds resolve the package from npm.
