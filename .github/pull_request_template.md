<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Summary

<!-- What changed and why. Link the issue/epic. -->

## Tier and boundary impact

- [ ] Tier 1 (SynapseOne): headless core only; no product UI or domain model.
- [ ] Tier 2 (SynapseDX): reusable H-P-D-I capability; no Tier-1 SDK import in a Tier-3 product.
- [ ] Tier 3 (SynapseCity / SynapseCitySOS): domain rules only; uses the Tier-2 API/SDK.
- [ ] No cross-product call between SynapseCity and SynapseCitySOS.
- [ ] Public HTTPS URLs only; no localhost/private-service fallback in production config.

## Verification

- [ ] Unit/contract tests pass (`npm test`, `pytest`, `go test` as applicable).
- [ ] Build passes from source.
- [ ] Docker/compose config and image build pass (when touched).
- [ ] UI change has a screenshot and a smoke/E2E check.
- [ ] New endpoint is documented and tenant/role-scoped.

## Release and licensing

- [ ] New source files carry the Apache-2.0 SPDX header.
- [ ] `CHANGELOG.md` updated for user-visible changes.
- [ ] No secrets, `.env` values, tokens or operator notes committed.
- [ ] Release assets remain open formats (no zip/rar).
