# Tier-3 runner contract

Tier-2 has no timer process and no in-memory work queue. A scheduled job has
one of two executors:

| Executor | Scheduler | Execution | Use |
| --- | --- | --- | --- |
| `workflow` (default) | Tier-1 workflow cron | Tier-1 workflow engine | Generic workflow jobs |
| `runner` | Tier-2 `nextRunAt` projection | Tier-3 process | Domain jobs (`vndms.ingest`, `hazard.expire`, `report.generate`) |

The runner contract is deliberately "Tier-3 owns the loop, Tier-2 owns the
lease". Tier-1 Faststore is the distributed lock; Tier-1 Base stores job/run
records. No cross-product API call between City and SOS is involved.

## Built-in kinds

`GET /v1/capabilities/jobs/kinds` returns the catalog:

| Kind | Required payload | Notes |
| --- | --- | --- |
| `vndms.ingest` | `url` (public HTTPS) | Optional `district`, `format: json\|xml`, `since`. The runner fetches/parses/persists hazards and reports counts. |
| `hazard.expire` | — | Optional `ttlMinutes` (1..259200), `dryRun`. The runner expires hazards and emits the product event. |
| `report.generate` | `reportType` | Optional `format: pdf\|csv\|json`, `datasetId`, `fileId`. The runner generates the artifact and uploads it through the files capability. |
| `generic` | — | Custom product job; Tier-3 owns payload semantics. |

Custom kinds are allowed; the catalog is advisory. Runner jobs can still be
listed, updated, deleted and observed like workflow jobs.

## Lifecycle

```text
create (executor=runner) -> nextRunAt / run-now queue
      -> POST /jobs/lease (leaseToken, runId, payload, attempt)
      -> heartbeat (optional, extends lease)
      -> POST /jobs/:id/runs/:runId/complete
             succeeded -> lastStatus=succeeded
             failed    -> retry queued with backoff until maxAttempts
             dead      -> terminal
```

- Only one runner holds a job lease at a time (`Faststore ifNotExists`).
- Manual `POST /jobs/:id/run` queues a run; repeated calls return the same
  queued run (`deduplicated: true`).
- `leaseSeconds` is 10..3600 (default 60). A crashed runner's lease expires and
  the job is reclaimable.
- `maxAttempts` is 1..10 (default 3). Retry backoff is `min(300, 10*attempt)`
  seconds.
- Job and run documents are tenant-scoped; another tenant gets `404`.
- Deleting a runner job cancels queued/leased run records and drops the lease.

## Tier-3 loop (reference)

```ts
import { CapabilitiesClient } from '@synapsedx/capabilities';

const client = new CapabilitiesClient({
  token: process.env.SYNAPSEDX_TOKEN, // product-scoped Tier-1 credential
  product: 'sos',
});

async function tick() {
  const { leases } = await client.jobs.lease({ runnerId: 'sos-runner-1', limit: 5, leaseSeconds: 120 });
  for (const lease of leases) {
    try {
      const summary = await handle(lease.kind, lease.payload); // product code
      await client.jobs.complete(lease.jobId, lease.runId, {
        leaseToken: lease.leaseToken, status: 'succeeded', summary,
      });
    } catch (error) {
      await client.jobs.complete(lease.jobId, lease.runId, {
        leaseToken: lease.leaseToken, status: 'failed', error: String(error),
      });
    }
  }
}

async function handle(kind: string, payload: Record<string, unknown>) {
  switch (kind) {
    case 'vndms.ingest': return vndmsIngest(payload);      // product implementation
    case 'hazard.expire': return expireHazards(payload);   // product implementation
    case 'report.generate': return generateReport(payload);// product implementation
    default: throw new Error(`unknown job kind ${kind}`);
  }
}
```

The Tier-3 process is expected to run this loop on a platform scheduler
(Kubernetes CronJob, systemd timer, or a long-lived worker) and expose its own
last-run/next-run status. Tier-2 exposes the authoritative `nextRunAt`,
`lastRunAt`, `lastStatus`, `lastError` and run history at
`GET /v1/capabilities/jobs/:id`.

## Acceptance mapping (#26)

- Tier-2 job API + typed SDK (`jobs.lease/heartbeat/complete/kinds`): done.
- Lease/run-now/retry/dead-letter semantics and tenant isolation: tested in
  `apps/capabilities-service/src/job-runner.test.ts`.
- SOS hazard expiry and VNDMS ingest still need the product handlers/loop in
  `SynapseCitySOS`; that adoption is tracked there, not in this repository.
- Report artifacts use the files capability from #9.
