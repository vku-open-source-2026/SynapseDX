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

## Testing backends (memory vs Postgres)

Unit tests run against the in-memory DB by default (no `DATABASE_URL`) and the
IAM suites explicitly force memory (`scoping.test.ts` deletes `DATABASE_URL`
before importing the app), so `npm test` does **not** exercise the Postgres
branches. Validate persistence through the Docker stack instead:

```bash
docker compose up -d
SYNAPSEDX_BASE_URL=http://localhost:18080 bash tests/e2e/api-check.sh
SYNAPSEDX_BASE_URL=http://localhost:18080 node tests/e2e/services-check.js
```

The E2E scripts create fixed slugs (`e2e`, `sdkacc`, `pyfull`), so they are not
rerunnable against a dirty database. Delete those test accounts or use a fresh
database before rerunning them.

## Database schema & migrations

Each Postgres-backed service owns its schema and migrations:

| Service | Drizzle schema | Migration journal |
|---|---|---|
| IAM | `apps/iam-service/src/schema.ts` | `drizzle.__drizzle_migrations_iam` |
| Workflow | `apps/workflow-service/src/schema.ts` | `drizzle.__drizzle_migrations_workflow` |
| LDS | `apps/lds-service/src/schema.ts` | `drizzle.__drizzle_migrations_lds` |
| Base | `apps/base-service/src/schema.ts` | `drizzle.__drizzle_migrations_base` |

`infra/postgres/init.sql` only installs database extensions and creates the
`drizzle` migration-journal schema. Tables, indexes and the demo `acme` / `prod`
seed are created by versioned migrations when a service starts. Migrations are
applied under a per-service PostgreSQL advisory lock.

To change a schema, edit `src/schema.ts`, then generate a migration with Node 20
(the repo's supported runtime):

```bash
cd apps/iam-service   # or lds-service / workflow-service / base-service
npm run db:generate
```

Review the generated SQL before committing it. Never edit a migration that has
already been applied; add a new migration instead. Startup migrations must stay
safe for both fresh and pre-existing databases (use `IF NOT EXISTS` /
conditional constraint creation where needed).

## Commit style
Conventional Commits: `feat(iam): ...`, `fix(gateway): ...`, `docs: ...`, `chore: ...`.

## DCO
Sign-off your commits (`git commit -s`) to certify origin per Developer Certificate of Origin.
