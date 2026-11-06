# @synapsedx/capabilities

JavaScript/TypeScript client for the SynapseDX Tier-2 capabilities API.
Tier-3 products (SynapseCity, SynapseCitySOS) consume this package; they never
import `@synapseone/sdk` or call SynapseOne directly.

```bash
npm install @synapsedx/capabilities
```

```ts
import { CapabilitiesClient } from '@synapsedx/capabilities';

const dx = new CapabilitiesClient({
  baseUrl: 'https://synapsedx.sbs',
  // A Tier-1-verifiable credential. Tier-2 verifies it with IAM and scopes
  // private dataset access to the principal's tenant.
  token: process.env.SYNAPSEONE_TOKEN,        // Authorization: Bearer
  // apiKey: process.env.SYNAPSEONE_API_KEY,  // X-API-Key (alternative)
  tenant: process.env.SYNAPSEONE_TENANT,
  product: 'city',
});
```

There is no Tier-2-only API key. The credential must be accepted by
`https://api.synapseone.space/v1/auth/verify`; the Tier-2 service key is never
used as a fallback for anonymous callers.

## Datasets and records

```ts
const dataset = await dx.datasets.create({
  slug: 'city-incidents',
  name: 'City incidents',
  entityType: 'Incident',
  license: 'CC-BY-4.0',
  public: true,
  schemaVersion: '1.0.0',
});

await dx.datasets.publish(dataset.id);

// Caller-supplied ids are preserved exactly.
const record = await dx.records.create(dataset.id, { title: 'pothole' }, {
  id: 'INC_2026_001',
  publish: false,            // withheld from the public NGSI-LD projection
  idempotencyKey: 'incident-create-0001',
});

// Optimistic concurrency: send the version you read.
await dx.records.update(dataset.id, record.id, { title: 'pothole', status: 'open' }, {
  ifVersion: record.version,
});

const page = await dx.records.query(dataset.id, {
  where: { status: 'open' },
  orderBy: 'updatedAt:desc',
  limit: 100,
});

for await (const item of dx.records.iterate(dataset.id, { limit: 500 })) {
  // pages through the whole dataset without a 500-document window
}

await dx.records.delete(dataset.id, record.id);
```

`publish` is a tri-state on record writes:

| value | effect |
| --- | --- |
| `true` | publish the record; `409 dataset_not_published` unless the dataset is public and published |
| `false` | never project the record; an existing projection is withdrawn |
| omitted | inherit the dataset default |

## Knowledge & hazards (Tier-2 LLM base)

```ts
// Hybrid vector + graph RAG with citations.
const answer = await dx.knowledge.query({
  question: 'Tình hình mưa lớn hôm nay thế nào?',
  topK: 5,
  context: '- [high] Mưa lớn tại miền Trung (feed cảnh báo hiện tại)',
});
console.log(answer.answer, answer.citations);

// Grounded situation brief from today's hazard feed.
const brief = await dx.hazards.brief({ hours: 24, limit: 8 });
console.log(brief.brief, brief.model, brief.fallback);

const today = await dx.hazards.today({ hours: 24, limit: 50 });
const status = await dx.hazards.status();
```

`knowledge.query` runs on the Tier-2 knowledge base (Tier-1 SynapseBase
documents + pgvector + graph) and returns `answer`, `citations` (with source
URLs) and expanded `entities`. `hazards.brief` uses the same live feed and
returns a deterministic, clearly-labelled fallback when the LLM is unavailable.

## Pagination, errors and events

- `datasets.list()` keeps the historical `Dataset[]` return value.
  `datasets.listPage()` adds `total`, `limit`, `offset` and `nextCursor`.
- `records.list()`/`records.query()` return `{items,total,limit,offset,nextCursor}`.
- `datasets.entitiesPage()` returns the NGSI-LD entities plus the license,
  datasource and total propagated from SynapseLDS.
- Errors are `CapabilitiesError` with `status`, `code`, `requestId`, `details`
  and `body`. Network failures keep the original `cause`.

```ts
try {
  await dx.datasets.publish('missing');
} catch (error) {
  if (error instanceof CapabilitiesError) {
    console.error(error.code, error.requestId, error.details);
  }
}

const feed = await dx.events.list({ since: cursor, datasetId: dataset.id });
cursor = feed.nextCursor;
```

Event delivery is at-least-once. Deduplicate on `event.eventId`; events carry
`correlationId`, `schemaVersion: 1` and an optional `idempotencyKey`.

## Identity and sessions

```ts
const session = await dx.auth.login({ email, password });
const registered = await dx.auth.register({ email, password, displayName });
await dx.auth.changePassword('old-password', 'new-password');
const reset = await dx.auth.requestPasswordReset(email);
await dx.auth.resetPassword(reset.resetToken!, 'new-password');
const sessions = await dx.auth.sessions();
await dx.auth.revokeSession(sessions[0].id);

// Tier-2 service -> user-scoped Tier-1 token (service/admin credential).
const delegated = await dx.auth.exchange({
  userId, audience: 'synapsecity', scopes: ['read'],
});
```

Password login/registration and reset are live. Login/refresh responses are
never cached. Passwordless login is Tier-1 dev-only.

## Files

```ts
const file = await dx.files.create({ filename: 'evacuation.pdf', contentType: 'application/pdf' });
await dx.files.uploadBytes(file.id, bytes, { contentType: 'application/pdf' });
// or one call:
await dx.files.upload({ filename: 'evacuation.pdf', contentType: 'application/pdf', content: bytes });

const downloaded = await dx.files.download(file.id); // Uint8Array
const quota = await dx.files.quota();
const signed = await dx.files.presign(file.id, { method: 'PUT', expiresIn: 600 });
// after the browser PUTs to signed.url:
await dx.files.complete(file.id);
```

Cross-tenant file ids return `404 file_not_found`; presign on the filesystem
backend returns `501 presign_unsupported`.

## Notifications

```ts
await dx.notifications.createTemplate({
  id: 'hazard-alert', name: 'Hazard alert', channel: 'email',
  subject: 'Hazard in {{district}}',
  body: 'Level {{level}} hazard in {{district}}.',
});

await dx.notifications.send({
  template: 'hazard-alert', to: 'citizen@example.test',
  variables: { district: 'Hai Chau', level: 3 },
  idempotencyKey: 'alert-2026-0001',
});

const status = await dx.notifications.get('notification-id');
await dx.notifications.setPreference('citizen@example.test', { unsubscribed: true });
```

Same-key sends are deduplicated by Tier-1; a suppressed recipient returns
`409 notification_suppressed`.

## Scheduled runner jobs

```ts
const job = await dx.jobs.create({
  name: 'hazard-expiry', kind: 'hazard.expire', executor: 'runner',
  schedule: { cron: '*/5 * * * *' }, payload: { ttlMinutes: 60 },
});

const { leases } = await dx.jobs.lease({ runnerId: 'sos-runner-1', leaseSeconds: 120 });
for (const lease of leases) {
  try {
    const summary = await runHandler(lease.kind, lease.payload);
    await dx.jobs.complete(lease.jobId, lease.runId, {
      leaseToken: lease.leaseToken, status: 'succeeded', summary,
    });
  } catch (error) {
    await dx.jobs.complete(lease.jobId, lease.runId, {
      leaseToken: lease.leaseToken, status: 'failed', error: String(error),
    });
  }
}
```

Tier-2 projects `nextRunAt`/`lastRunAt` and leases through Tier-1 Faststore;
Tier-3 owns the polling loop and the domain handlers. See `docs/RUNNER.md` in
the SynapseDX repository.

## Search and geocoding

```ts
const suggestions = await dx.geo.autocomplete({ q: 'Hai Chau', limit: 5 });
const matches = await dx.geo.geocode('Hai Chau, Da Nang');
const nearby = await dx.geo.reverse(16.06, 108.22);
const place = await dx.geo.place(suggestions[0].id!);
```

Results are normalized to `{id,label,address,lat,lon,raw}`. The operator's
provider key stays server-side. With no provider configured the routes return
`503 geocoder_unavailable` (configuration, not a missing Tier-1 primitive).

## Health

```ts
const health = await dx.health();
if (health.status !== 'ok') {
  for (const dependency of health.dependencies.filter((d) => d.status !== 'ok')) {
    console.warn(dependency.name, dependency.status, dependency.error);
  }
}
```

## Release status

`@synapsedx/capabilities@0.3.0` is prepared for registry release (`files`
excludes test artifacts, `LICENSE`/`NOTICE` are included, `engines.node >= 20`).
The local `npm pack` + consumer-install checks pass. Publishing to npm requires
the operator's `@synapsedx` scope token; the runbook is in
`docs/RELEASE.md` in the SynapseDX repository.
