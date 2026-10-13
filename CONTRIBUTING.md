# Contributing to synapsedx

Thanks for considering contributing. synapsedx follows standard open-source practices.

## Ground rules
- License: Apache-2.0. By contributing you agree your contribution is under the same license (see `LICENSE`).
- Be respectful — see `CODE_OF_CONDUCT.md`.
- Security issues: **do not** open public issues — see `SECURITY.md`.

## Workflow
1. Fork → branch (`feat/<scope>`, `fix/<scope>`, `docs/<scope>`).
2. `make bootstrap && make build && make test && make license-check`.
3. Keep PRs small and focused; include tests for behavior changes.
4. Run `docker compose config` and relevant service tests before pushing.
5. New dependencies must be permissively licensed (MIT/ISC/Apache-2.0/BSD) — the CI
   copyleft gate (`tools/license-check.cjs`) fails on GPL/AGPL/LGPL and friends.
5. Open PR against `main` with: what/why, how tested, docs updated if API changed.

## Dev loop
```bash
cp .env.example .env
npm install --workspaces
npm run dev --workspace=apps/iam-service     # :4001
npm run dev --workspace=apps/workflow-service # :4002
npm run dev --workspace=apps/gateway          # :8080
# e2e smoke:
bash tests/e2e/smoke.sh
```
Windows without `make`: call `docker compose ...` / `npm run ...` directly
as above (see also `tests/e2e/smoke.ps1`, `examples/quickstart/demo.ps1`).

## Commit style
Conventional Commits: `feat(iam): ...`, `fix(gateway): ...`, `docs: ...`, `chore: ...`.

## DCO
Sign-off your commits (`git commit -s`) to certify origin per Developer Certificate of Origin.
