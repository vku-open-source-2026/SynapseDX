// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from "node:test";
import assert from "node:assert/strict";
import { CapabilitiesClient, CapabilitiesError } from "./index";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface MockResult {
  status?: number;
  body?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

function mockFetch(
  handler: (request: Captured) => MockResult | Promise<MockResult>,
) {
  const requests: Captured[] = [];
  const impl = (async (input: any, init: any = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const captured: Captured = {
      url: String(input),
      method: String(init.method || "GET").toUpperCase(),
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    requests.push(captured);
    const result = await handler(captured);
    return new Response(
      result.bytes !== undefined
        ? (result.bytes as unknown as BodyInit)
        : result.body === undefined
          ? ""
          : JSON.stringify(result.body),
      {
        status: result.status ?? 200,
        headers: {
          "content-type":
            result.bytes !== undefined
              ? "application/octet-stream"
              : "application/json",
          ...(result.headers || {}),
        },
      },
    );
  }) as unknown as typeof fetch;
  return { impl, requests };
}

test("defaults to the public SynapseDX domain", () => {
  const { impl, requests } = mockFetch(() => ({ body: {} }));
  const client = new CapabilitiesClient({ fetch: impl });
  assert.equal((client as any).http.baseUrl, "https://synapsedx.sbs");
  assert.equal(requests.length, 0);
});

test("rejects localhost as a runtime dependency", () => {
  const previous = process.env.ALLOW_LOCAL_DEPENDENCIES;
  delete process.env.ALLOW_LOCAL_DEPENDENCIES;
  assert.throws(
    () => new CapabilitiesClient({ baseUrl: "http://127.0.0.1:8082" }),
    /local dependency/,
  );
  process.env.ALLOW_LOCAL_DEPENDENCIES = "true";
  assert.doesNotThrow(
    () => new CapabilitiesClient({ baseUrl: "http://127.0.0.1:8082" }),
  );
  if (previous === undefined) delete process.env.ALLOW_LOCAL_DEPENDENCIES;
  else process.env.ALLOW_LOCAL_DEPENDENCIES = previous;
});

test("sends credentials, tenant, correlation, idempotency and version preconditions", async () => {
  const { impl, requests } = mockFetch(() => ({
    body: {
      id: "r1",
      data: { x: 1 },
      version: 2,
      createdAt: "a",
      updatedAt: "b",
    },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "tok",
    tenant: "acct-a",
    product: "city",
    fetch: impl,
  });
  await client.records.update(
    "ds",
    "AST_001",
    { x: 1 },
    {
      idempotencyKey: "op-00000001",
      ifVersion: 2,
      correlationId: "corr-1",
    },
  );
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.method, "PATCH");
  assert.match(
    request.url,
    /\/v1\/capabilities\/datasets\/ds\/records\/AST_001$/,
  );
  assert.equal(request.headers.authorization, "Bearer tok");
  assert.equal(request.headers["x-synapseone-tenant"], "acct-a");
  assert.equal(request.headers["x-synapsedx-product"], "city");
  assert.equal(request.headers["idempotency-key"], "op-00000001");
  assert.equal(request.headers["if-match"], '"2"');
  assert.equal(request.headers["x-correlation-id"], "corr-1");
});

test("records.create sends the per-record publication flag and returns typed metadata", async () => {
  const { impl, requests } = mockFetch(() => ({
    status: 201,
    body: {
      id: "r1",
      data: { x: 1 },
      version: 1,
      published: false,
      createdAt: "c",
      updatedAt: "u",
    },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    apiKey: "key",
    fetch: impl,
  });
  const record = await client.records.create(
    "ds",
    { x: 1 },
    { id: "r1", publish: false },
  );
  assert.deepEqual(requests[0].body, {
    data: { x: 1 },
    id: "r1",
    publish: false,
  });
  assert.equal(requests[0].headers["x-api-key"], "key");
  assert.equal(record.published, false);
  assert.equal(record.version, 1);
  assert.equal(record.createdAt, "c");
});

test("listPage and entitiesPage read pagination and license metadata headers", async () => {
  const { impl } = mockFetch((request): MockResult => {
    if (request.url.includes("/entities")) {
      return {
        body: [{ id: "urn:1" }],
        headers: {
          "x-lds-total": "7",
          "x-lds-license": "CC-BY-4.0",
          "x-lds-datasource": "synapsedx-city-incidents",
          "x-lds-context": "https://ctx",
          "cache-control": "public, max-age=60",
        },
      };
    }
    return {
      body: [{ id: "d1" }],
      headers: {
        "x-total-count": "3",
        "x-limit": "1",
        "x-offset": "0",
        "x-next-cursor": "abc",
      },
    };
  });
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    fetch: impl,
  });
  const page = await client.datasets.listPage({ limit: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.nextCursor, "abc");
  const entities = await client.datasets.entitiesPage("d1");
  assert.equal(entities.total, 7);
  assert.equal(entities.license, "CC-BY-4.0");
  assert.equal(entities.datasourceId, "synapsedx-city-incidents");
  assert.deepEqual(entities.contexts, ["https://ctx"]);
});

test("query, bulkCreate and delete use the documented routes", async () => {
  const { impl, requests } = mockFetch((request) => {
    if (request.method === "DELETE") return { body: null };
    return {
      body: {
        items: [],
        total: 0,
        limit: 10,
        offset: 0,
        nextCursor: null,
        created: [],
        errors: [],
      },
    };
  });
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    fetch: impl,
  });
  await client.records.query("ds", {
    where: { status: "open" },
    orderBy: "id:asc",
    limit: 10,
  });
  await client.records.bulkCreate("ds", [
    { id: "a", data: { x: 1 } },
    { data: { x: 2 } },
  ]);
  await client.records.delete("ds", "a");
  assert.equal(
    requests[0].url,
    "https://dx.example/v1/capabilities/datasets/ds/records/query",
  );
  assert.deepEqual(requests[0].body, {
    where: { status: "open" },
    orderBy: "id:asc",
    limit: 10,
  });
  assert.equal(
    requests[1].url,
    "https://dx.example/v1/capabilities/datasets/ds/records/bulk",
  );
  assert.equal(requests[2].method, "DELETE");
  assert.match(requests[2].url, /records\/a$/);
});

test("errors expose status, code, requestId and details", async () => {
  const { impl } = mockFetch(() => ({
    status: 409,
    body: {
      error: {
        code: "version_conflict",
        message: "stale",
        requestId: "req-1",
        details: { currentVersion: 4 },
      },
    },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "t",
    retries: 0,
    fetch: impl,
  });
  await assert.rejects(
    () => client.records.update("ds", "r1", { x: 1 }, { ifVersion: 3 }),
    (error: unknown) => {
      assert.ok(error instanceof CapabilitiesError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "version_conflict");
      assert.equal(error.requestId, "req-1");
      assert.deepEqual(error.details, { currentVersion: 4 });
      return true;
    },
  );
});

test("network failures keep the original cause", async () => {
  const impl = (async () => {
    throw new Error("socket hang up");
  }) as unknown as typeof fetch;
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    retries: 0,
    fetch: impl,
  });
  await assert.rejects(
    () => client.health(),
    (error: unknown) => {
      assert.ok(error instanceof CapabilitiesError);
      assert.equal((error.cause as Error).message, "socket hang up");
      assert.ok(error.requestId);
      return true;
    },
  );
});

test("iterate pages through a large record set", async () => {
  let calls = 0;
  const { impl } = mockFetch((request) => {
    const body = request.body as { offset: number; limit: number };
    calls += 1;
    const offset = body.offset;
    const items = Array.from(
      { length: Math.min(2, 5 - offset) },
      (_, index) => ({
        id: `r${offset + index}`,
        data: {},
        version: 1,
        createdAt: "c",
        updatedAt: "u",
      }),
    );
    return {
      body: { items, total: 5, limit: body.limit, offset, nextCursor: null },
    };
  });
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    fetch: impl,
    retries: 0,
  });
  const ids: string[] = [];
  for await (const record of client.records.iterate("ds", { limit: 2 }))
    ids.push(record.id);
  assert.deepEqual(ids, ["r0", "r1", "r2", "r3", "r4"]);
  assert.equal(calls, 3);
});

test("health and ready are typed and share the dependency contract", async () => {
  const { impl } = mockFetch(() => ({
    body: {
      status: "ok",
      service: "synapsedx-capabilities",
      tier: 2,
      version: "0.2.0",
      dependencies: [
        { name: "base", status: "ok", latency_ms: 3, critical: true },
      ],
      time: "now",
    },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    fetch: impl,
  });
  const health = await client.health();
  assert.equal(health.status, "ok");
  assert.equal(health.dependencies[0].name, "base");
  const ready = await client.ready();
  assert.equal(ready.tier, 2);
});

test("unavailable capabilities surface their dependency through the typed error", async () => {
  const { impl } = mockFetch(() => ({
    status: 503,
    body: {
      error: {
        code: "presign_unsupported",
        message:
          "presigned URLs are not available on this Tier-1 storage backend",
        requestId: "req-2",
        details: { backend: "fs" },
      },
    },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "t",
    retries: 0,
    fetch: impl,
  });
  await assert.rejects(
    () => client.files.presign("f1"),
    (error: unknown) => {
      assert.ok(error instanceof CapabilitiesError);
      assert.equal(error.code, "presign_unsupported");
      assert.equal((error.details as any).backend, "fs");
      return true;
    },
  );
});

test("auth namespace covers the first-party lifecycle and delegated exchange", async () => {
  const { impl, requests } = mockFetch((request) => {
    if (request.url.endsWith("/auth/register"))
      return { status: 201, body: { accessToken: "a", refreshToken: "r" } };
    if (request.url.endsWith("/auth/login"))
      return { body: { accessToken: "a", refreshToken: "r" } };
    if (request.url.endsWith("/auth/password/forgot"))
      return { status: 202, body: { ok: true, resetToken: "reset-1" } };
    if (request.url.endsWith("/auth/sessions"))
      return {
        body: [
          { id: "s1", created_at: "c", expires_at: null, revoked_at: null },
        ],
      };
    if (request.url.endsWith("/auth/exchange"))
      return {
        status: 201,
        body: {
          accessToken: "d",
          delegated: true,
          userId: "u1",
          orgId: "o",
          accountId: "a",
          scopes: ["read"],
          expiresIn: 900,
          tokenType: "Bearer",
        },
      };
    return { body: { ok: true, revokedSessions: 0 } };
  });
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "t",
    fetch: impl,
  });
  const registered = await client.auth.register({
    email: "a@example.test",
    password: "secret-password",
  });
  assert.equal(registered.accessToken, "a");
  await client.auth.login({
    email: "a@example.test",
    password: "secret-password",
  });
  await client.auth.changePassword("old", "new");
  const reset = await client.auth.requestPasswordReset("a@example.test");
  assert.equal(reset.resetToken, "reset-1");
  await client.auth.resetPassword("reset-1", "newer");
  const sessions = await client.auth.sessions();
  assert.equal(sessions[0].id, "s1");
  const delegated = await client.auth.exchange({
    userId: "u1",
    audience: "synapsecity",
    scopes: ["read"],
  });
  assert.equal(delegated.delegated, true);
  assert.equal(
    (requests.find((r) => r.url.endsWith("/auth/exchange"))!.body as any)
      .audience,
    "synapsecity",
  );
});

test("files namespace uploads raw bytes, downloads them and requests presigned URLs", async () => {
  const { impl, requests } = mockFetch((request) => {
    if (request.url.endsWith("/files") && request.method === "POST") {
      return {
        status: 201,
        body: {
          id: "f1",
          filename: "a.bin",
          contentType: "application/octet-stream",
          size: 0,
          downloadUrl: "/v1/capabilities/files/f1/content",
          createdAt: "c",
          updatedAt: "u",
          upload: {
            method: "PUT",
            url: "/v1/capabilities/files/f1/content",
            contentType: "application/octet-stream",
            maxBytes: 1024,
          },
        },
      };
    }
    if (request.url.endsWith("/content") && request.method === "PUT") {
      return {
        body: {
          id: "f1",
          filename: "a.bin",
          contentType: "application/octet-stream",
          size: 3,
          checksumSha256: "abc",
          downloadUrl: "/x",
          createdAt: "c",
          updatedAt: "u",
        },
      };
    }
    if (request.url.includes("/public/files/f1/content")) {
      return {
        bytes: new Uint8Array([4, 5]),
        headers: { "x-checksum-sha256": "def" },
      };
    }
    if (request.url.endsWith("/content") && request.method === "GET") {
      return {
        bytes: new Uint8Array([1, 2, 3]),
        headers: { "x-checksum-sha256": "abc" },
      };
    }
    if (request.url.endsWith("/public/files/f1")) {
      return {
        body: {
          id: "f1",
          filename: "release.apk",
          contentType: "application/vnd.android.package-archive",
          size: 2,
          public: true,
          publicUrl: "/v1/capabilities/public/files/f1/content",
          downloadUrl: "/x",
          createdAt: "c",
          updatedAt: "u",
        },
      };
    }
    return {
      body: {
        fileId: "f1",
        method: "GET",
        url: "https://s3.example/x",
        expiresIn: 900,
      },
    };
  });
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "t",
    fetch: impl,
  });
  const ticket = await client.files.create({ filename: "a.bin" });
  assert.equal(ticket.upload.method, "PUT");
  const uploaded = await client.files.uploadBytes(
    "f1",
    new Uint8Array([1, 2, 3]),
    { contentType: "application/octet-stream" },
  );
  assert.equal(uploaded.size, 3);
  assert.deepEqual(
    Array.from(
      requests[1].headers
        ? new Uint8Array(requests[1].body as unknown as Uint8Array)
        : [],
    ),
    [1, 2, 3],
  );
  assert.equal(requests[1].headers["content-type"], "application/octet-stream");
  const downloaded = await client.files.download("f1");
  assert.deepEqual(Array.from(downloaded.data), [1, 2, 3]);
  assert.equal(downloaded.checksumSha256, "abc");
  const presigned = await client.files.presign("f1", {
    method: "PUT",
    expiresIn: 600,
  });
  assert.equal(presigned.method, "GET");
  assert.equal((requests[3].body as any).method, "PUT");
  const publicMeta = await client.files.publicGet("f1");
  assert.equal(publicMeta.public, true);
  assert.equal(
    publicMeta.publicUrl,
    "/v1/capabilities/public/files/f1/content",
  );
  const publicBytes = await client.files.publicDownload("f1");
  assert.deepEqual(Array.from(publicBytes.data), [4, 5]);
  assert.equal(publicBytes.checksumSha256, "def");
});

test("notifications namespace sends templates and manages preferences", async () => {
  const { impl, requests } = mockFetch((request) => {
    if (
      request.url.endsWith("/notifications/templates") &&
      request.method === "POST"
    ) {
      return {
        status: 201,
        body: {
          id: "tpl-hazard",
          name: "Hazard",
          channel: "email",
          body: "x",
          subject: "",
        },
      };
    }
    if (request.url.endsWith("/notifications/send")) {
      return {
        status: 202,
        body: {
          notifications: [{ id: "n1", channel: "email", status: "queued" }],
          requested: 1,
        },
      };
    }
    if (request.url.includes("/preferences/"))
      return {
        body: {
          recipient: "r@example.test",
          channels: [],
          unsubscribed: false,
        },
      };
    return { body: { items: [], count: 0 } };
  });
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "t",
    fetch: impl,
  });
  const template = await client.notifications.createTemplate({
    id: "tpl-hazard",
    name: "Hazard",
    channel: "email",
    body: "x",
  });
  assert.equal(template.id, "tpl-hazard");
  const sent = await client.notifications.send({
    template: "tpl-hazard",
    to: "r@example.test",
    variables: { level: 3 },
  });
  assert.equal(sent.notifications[0].id, "n1");
  assert.equal((requests[1].body as any).template, "tpl-hazard");
  const preference = await client.notifications.getPreference("r@example.test");
  assert.equal(preference.unsubscribed, false);
});

test("jobs namespace exposes kinds, leases, heartbeats and completion", async () => {
  const { impl } = mockFetch((request) => {
    if (request.url.endsWith("/jobs/kinds"))
      return {
        body: {
          items: [{ kind: "vndms.ingest", description: "d", fields: {} }],
          runnerContract: { lease: "l", heartbeat: "h", complete: "c" },
        },
      };
    if (request.url.endsWith("/jobs/lease"))
      return {
        body: {
          leases: [
            {
              jobId: "j1",
              runId: "r1",
              kind: "vndms.ingest",
              payload: {},
              attempt: 1,
              leaseToken: "lt",
              leaseExpiresAt: "e",
              timeoutSeconds: 300,
            },
          ],
          runnerId: "runner",
          count: 1,
        },
      };
    if (request.url.endsWith("/heartbeat"))
      return { body: { runId: "r1", leaseExpiresAt: "later" } };
    if (request.url.endsWith("/complete"))
      return {
        body: {
          run: { id: "r1", status: "succeeded", attempt: 1 },
          retry: false,
        },
      };
    return { body: {} };
  });
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "t",
    fetch: impl,
  });
  const kinds = await client.jobs.kinds();
  assert.equal(kinds.items[0].kind, "vndms.ingest");
  const lease = await client.jobs.lease({ runnerId: "runner" });
  assert.equal(lease.leases[0].leaseToken, "lt");
  const heartbeat = await client.jobs.heartbeat("j1", "r1", "lt", {
    leaseSeconds: 60,
  });
  assert.equal(heartbeat.leaseExpiresAt, "later");
  const completion = await client.jobs.complete("j1", "r1", {
    leaseToken: "lt",
    status: "succeeded",
  });
  assert.equal(completion.run.status, "succeeded");
});

test("geo namespace returns normalized provider items", async () => {
  const { impl } = mockFetch((request) =>
    request.url.includes("/geo/place")
      ? { body: { provider: "vietmap", result: null } }
      : {
          body: {
            provider: "vietmap",
            items: [{ id: "p1", label: "Hai Chau", lat: 16, lon: 108 }],
          },
        },
  );
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "t",
    fetch: impl,
  });
  const items = await client.geo.autocomplete({ q: "Hai Chau" });
  assert.equal(items[0].label, "Hai Chau");
  const place = await client.geo.place("p1");
  assert.equal(place, null);
});

test("warehouse queries and report publishing use the stable capability paths", async () => {
  const { impl, requests } = mockFetch((request) => ({
    body: request.url.includes("/query")
      ? {
          columns: ["n"],
          rows: [{ n: 1 }],
          rowCount: 1,
          truncated: false,
          durationMs: 1,
        }
      : { id: "report-1", visibility: "published", shareId: "share-1" },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "tok",
    fetch: impl,
  });
  const result = await client.warehouse.query("SELECT 1 AS n", { limit: 10 });
  assert.equal(result.rowCount, 1);
  const published = await client.warehouse.publishReport("report-1");
  assert.equal(published.shareId, "share-1");
  assert.equal(
    requests[0].url,
    "https://dx.example/v1/capabilities/warehouse/query",
  );
  assert.deepEqual(requests[0].body, { sql: "SELECT 1 AS n", limit: 10 });
  assert.equal(
    requests[1].url,
    "https://dx.example/v1/capabilities/warehouse/reports/report-1/publish",
  );
});

test("workspace plugin management uses the fixed /workspaces paths and version payloads", async () => {
  const { impl, requests } = mockFetch(() => ({
    body: { id: "p1", version: 2, widgets: [] },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "tok",
    fetch: impl,
  });
  await client.workspaces.catalog();
  await client.workspaces.listPlugins("city", { limit: 10 });
  await client.workspaces.updatePlugin("p1", { version: 1, name: "Ops" });
  await client.workspaces.installPlugin("p1", ["volunteer"]);
  await client.workspaces.setMember("user-1", { city: ["volunteer"] });

  assert.equal(
    requests[0].url,
    "https://dx.example/v1/capabilities/workspaces/catalog",
  );
  assert.equal(
    requests[1].url,
    "https://dx.example/v1/capabilities/workspaces/plugins?product=city&limit=10",
  );
  assert.equal(requests[2].method, "PUT");
  assert.equal(
    requests[2].url,
    "https://dx.example/v1/capabilities/workspaces/plugins/p1",
  );
  assert.deepEqual(requests[2].body, { version: 1, name: "Ops" });
  assert.equal(
    requests[3].url,
    "https://dx.example/v1/capabilities/workspaces/plugins/p1/install",
  );
  assert.deepEqual(requests[3].body, { roles: ["volunteer"] });
  assert.equal(
    requests[4].url,
    "https://dx.example/v1/capabilities/workspaces/members/user-1",
  );
  assert.deepEqual(requests[4].body, { productRoles: { city: ["volunteer"] } });
});

test("workspace export can request the draft and build always uses the Tier-3 build path", async () => {
  const { impl, requests } = mockFetch(() => ({
    body: {
      format: "synapsedx-plugin",
      formatVersion: 1,
      plugin: {
        product: "city",
        name: "Ops",
        slug: "ops",
        audience: "member",
        roles: ["volunteer"],
        widgets: [],
      },
      source: {
        repository: "https://github.com/vku-open-source-2026/SynapseCity",
        path: "plugins/ops.plugin.json",
      },
      checksum: `sha256:${"a".repeat(64)}`,
    },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "tok",
    fetch: impl,
  });
  await client.workspaces.exportPlugin("p1");
  await client.workspaces.exportPlugin("p1", { draft: true });
  await client.workspaces.buildPlugin("p1");

  assert.equal(
    requests[0].url,
    "https://dx.example/v1/capabilities/workspaces/plugins/p1/export",
  );  assert.equal(
    requests[1].url,
    "https://dx.example/v1/capabilities/workspaces/plugins/p1/export?draft=1",
  );
  assert.equal(
    requests[2].url,
    "https://dx.example/v1/capabilities/workspaces/plugins/p1/build",
  );
  assert.equal(requests[2].method, "GET");
});

test("workspace revision restore posts to the forward-only restore path", async () => {
  const { impl, requests } = mockFetch(() => ({
    body: { id: "p1", version: 3, restoredFrom: 1, widgets: [] },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "tok",
    fetch: impl,
  });
  await client.workspaces.listPluginRevisions("p1", { limit: 25 });
  const restored = await client.workspaces.restorePluginRevision("p1", 1);

  assert.equal(
    requests[0].url,
    "https://dx.example/v1/capabilities/workspaces/plugins/p1/revisions?limit=25",
  );
  assert.equal(requests[1].method, "POST");
  assert.equal(
    requests[1].url,
    "https://dx.example/v1/capabilities/workspaces/plugins/p1/revisions/1/restore",
  );
  assert.deepEqual(requests[1].body, {});
  assert.equal(restored.restoredFrom, 1);
});

test("workspace widget execution sends exactly a values envelope", async () => {
  const { impl, requests } = mockFetch(() => ({
    body: {
      pluginId: "p1",
      widgetId: "w1",
      artifactId: "a1",
      submittedAt: "now",
      execution: {},
    },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "member",
    fetch: impl,
  });
  await client.workspaces.executeWidget("p1", "w1", {
    summary: "Broken lamp",
    severity: 2,
  });
  assert.equal(requests[0].method, "POST");
  assert.equal(
    requests[0].url,
    "https://dx.example/v1/capabilities/workspaces/installed/p1/widgets/w1/execute",
  );
  assert.deepEqual(requests[0].body, {
    values: { summary: "Broken lamp", severity: 2 },
  });
  assert.equal(requests[0].headers.authorization, "Bearer member");
});

test("workspace runtime uses X-Workspace-Token and no browser CORS header contract", async () => {
  const { impl, requests } = mockFetch(() => ({
    body: { items: [], total: 0 },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    fetch: impl,
  });
  await client.workspaces.runtime("city", "wsp_token");
  assert.equal(
    requests[0].url,
    "https://dx.example/v1/capabilities/workspaces/runtime/city",
  );
  assert.equal(requests[0].headers["x-workspace-token"], "wsp_token");
  assert.equal(requests[0].headers.authorization, undefined);
});

test("registered workspace queries and writes carry the action identifier outside the values envelope", async () => {
  const { impl, requests } = mockFetch(() => ({
    body: { items: [], total: 0 },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "member",
    fetch: impl,
  });
  await client.workspaces.widgetData("p1", "table", {
    action: "query-a",
    limit: 25,
    search: "lamp",
    sortBy: "name",
    sortDirection: "desc",
  });
  await client.workspaces.executeWidget(
    "p1",
    "form",
    { enabled: true },
    { actionId: "update-a" },
  );
  const query = new URL(requests[0].url);
  assert.equal(query.searchParams.get("action"), "query-a");
  assert.equal(query.searchParams.get("search"), "lamp");
  assert.equal(query.searchParams.get("sortBy"), "name");
  assert.equal(
    requests[1].url,
    "https://dx.example/v1/capabilities/workspaces/installed/p1/widgets/form/execute?action=update-a",
  );
  assert.deepEqual(requests[1].body, { values: { enabled: true } });
});

test("events.stream parses SSE frames incrementally and skips control frames", async () => {
  const encoder = new TextEncoder();
  const first = {
    eventId: "evt-1",
    type: "record.created",
    schemaVersion: 1 as const,
    datasetId: "city-incidents",
    at: "2026-11-15T00:00:00.000Z",
    correlationId: "corr-1",
  };
  const second = { ...first, eventId: "evt-2", recordId: "r-2" };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `retry: 3000\n\nevent: ready\ndata: {"cursor":null,"stream":"topic","filters":{"type":null,"datasetId":null}}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode(`: keepalive\n\n`));
      controller.enqueue(
        encoder.encode(
          `id: 1700000000000-0\nevent: capability\ndata: ${JSON.stringify({ id: "1700000000000-0", event: first })}\n\n`,
        ),
      );
      // Deliberately delivered in a later chunk: the generator must not wait
      // for the whole response.
      setTimeout(() => {
        controller.enqueue(
          encoder.encode(
            `id: 1700000000000-1\nevent: capability\ndata: ${JSON.stringify({ id: "1700000000000-1", event: second })}\n\n`,
          ),
        );
        controller.close();
      }, 5);
    },
  });
  let captured: { url: string; headers: Headers } | undefined;
  const impl = (async (input: any, init: any = {}) => {
    captured = { url: String(input), headers: new Headers(init.headers) };
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "read-token",
    fetch: impl,
  });

  const items: Array<{ id: string; event: typeof first }> = [];
  for await (const item of client.events.stream({
    since: "0-0",
    type: "record.created",
  })) {
    items.push(item as { id: string; event: typeof first });
    if (items.length === 1) {
      // The first frame is available before the second chunk was produced.
      assert.equal(item.event.eventId, "evt-1");
    }
  }

  assert.equal(items.length, 2);
  assert.deepEqual(items[1], {
    id: "1700000000000-1",
    event: second,
  });
  assert.ok(captured);
  assert.equal(
    captured.url,
    "https://dx.example/v1/capabilities/events/stream?since=0-0&type=record.created",
  );
  assert.equal(captured.headers.get("accept"), "text/event-stream");
  assert.equal(captured.headers.get("authorization"), "Bearer read-token");
  assert.equal(captured.headers.get("last-event-id"), null);
});

test("events.stream sends Last-Event-ID only when since is absent", async () => {
  const encoder = new TextEncoder();
  const body = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `retry: 3000\n\nevent: ready\ndata: {"cursor":"9-0","stream":"topic","filters":{"type":null,"datasetId":null}}\n\n`,
          ),
        );
        controller.close();
      },
    });
  const calls: Headers[] = [];
  const impl = (async (_input: any, init: any = {}) => {
    calls.push(new Headers(init.headers));
    return new Response(body(), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    apiKey: "read-key",
    fetch: impl,
  });

  for await (const _item of client.events.stream({ lastEventId: "9-0" })) {
    assert.fail("ready frames are not yielded");
  }
  for await (const _item of client.events.stream({
    since: "8-0",
    lastEventId: "9-0",
  })) {
    assert.fail("ready frames are not yielded");
  }

  assert.equal(calls[0].get("last-event-id"), "9-0");
  assert.equal(calls[0].get("x-api-key"), "read-key");
  assert.equal(calls[1].get("last-event-id"), null);
});

test("events.stream aborts without buffering the response", async () => {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `id: 1-0\nevent: capability\ndata: ${JSON.stringify({
            id: "1-0",
            event: {
              eventId: "evt-1",
              type: "record.created",
              schemaVersion: 1,
              datasetId: "ds",
              at: "2026-11-15T00:00:00.000Z",
              correlationId: "corr-1",
            },
          })}\n\n`,
        ),
      );
      abortController.signal.addEventListener(
        "abort",
        () => controller.error(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    },
  });
  const impl = (async (_input: any, init: any = {}) => {
    assert.equal(init.signal, abortController.signal);
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "read-token",
    fetch: impl,
  });

  const iterator = client.events.stream({}, { signal: abortController.signal });
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.id, "1-0");
  abortController.abort();
  await assert.rejects(iterator.next(), /abort/i);
});

test("events.stream surfaces a JSON error before any frame is yielded", async () => {
  const impl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "unauthorized",
          message: "a verified credential is required",
          requestId: "req-1",
        },
      }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    )) as unknown as typeof fetch;
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    fetch: impl,
  });
  await assert.rejects(async () => {
    for await (const _item of client.events.stream()) {
      assert.fail("no event should be yielded");
    }
  }, (error: any) => {
    assert.ok(error instanceof CapabilitiesError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "unauthorized");
    assert.equal(error.requestId, "req-1");
    return true;
  });
});

test("ai.chatStream POSTs stream:true and relays raw SSE frames (#89)", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: message\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`,
        ),
      );
      // Delivered in a later chunk: the generator must yield frames as they
      // arrive, not after the response ends.
      setTimeout(() => {
        controller.enqueue(
          encoder.encode(
            `event: message\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hello" } }] })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode("event: message\ndata: [DONE]\n\n"));
        controller.close();
      }, 5);
    },
  });
  let captured: { url: string; method?: string; headers: Headers; body?: string } | undefined;
  const impl = (async (input: any, init: any = {}) => {
    captured = {
      url: String(input),
      method: init.method,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : undefined,
    };
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "read-token",
    fetch: impl,
  });

  const frames: Array<{ event: string; data: string }> = [];
  let sawFirstFrameBeforeDone = false;
  for await (const frame of client.ai.chatStream(
    [{ role: "user", content: "hi" }],
    { model: "fake" },
  )) {
    frames.push(frame);
    if (frames.length === 1) sawFirstFrameBeforeDone = true;
  }

  assert.ok(sawFirstFrameBeforeDone);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].event, "message");
  assert.match(frames[0].data, /"delta":\{"role":"assistant"\}/);
  assert.match(frames[1].data, /"content":"hello"/);
  assert.equal(frames[2].data, "[DONE]");
  assert.ok(captured);
  assert.equal(captured.url, "https://dx.example/v1/capabilities/ai/chat");
  assert.equal(captured.method, "POST");
  assert.equal(captured.headers.get("accept"), "text/event-stream");
  assert.equal(captured.headers.get("authorization"), "Bearer read-token");
  assert.deepEqual(JSON.parse(captured.body!), {
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    model: "fake",
  });
});

test("ai.chatStream surfaces the JSON error envelope when the route refuses the stream", async () => {
  const impl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "upstream_unavailable",
          message: "the inference stream failed",
          requestId: "req-9",
        },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    fetch: impl,
  });
  await assert.rejects(async () => {
    for await (const _frame of client.ai.chatStream([{ role: "user", content: "hi" }])) {
      assert.fail("no frame should be yielded");
    }
  }, (error: any) => {
    assert.ok(error instanceof CapabilitiesError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "upstream_unavailable");
    return true;
  });
});

test("dataset spatial query, reindex and status use the documented routes", async () => {
  const { impl, requests } = mockFetch((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/records/spatial")) {
      return {
        body: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              id: "asset-1",
              geometry: { type: "Point", coordinates: [105.85, 21.03] },
              properties: { recordId: "asset-1", distanceMeters: 12 },
            },
          ],
          items: [
            {
              id: "asset-1",
              data: { name: "Pump" },
              version: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          total: 1,
          limit: 10,
          mode: "near",
        },
      };
    }
    if (url.pathname.endsWith("/records/spatial/reindex")) {
      return {
        body: {
          dataset_id: "city-assets",
          collection: "synapsedx_geo_city-assets",
          offset: 5000,
          scanned: 2,
          indexed: 2,
          removed: 0,
          skipped: 0,
          failed: 0,
          truncated: false,
        },
      };
    }
    return {
      body: {
        configured: true,
        field: "geometry",
        collection: "synapsedx_geo_city-assets",
        features: 2,
        extent: [105.8, 21.0, 105.9, 21.1],
      },
    };
  });
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "member",
    fetch: impl,
  });

  const result = await client.spatial.query("city-assets", {
    mode: "near",
    lat: 21.03,
    lng: 105.85,
    radiusMeters: 500,
    limit: 10,
  });
  assert.equal(result.features[0].properties.distanceMeters, 12);
  assert.equal(result.items[0].data.name, "Pump");

  const reindex = await client.spatial.reindex("city-assets", { offset: 5000 });
  assert.equal(reindex.indexed, 2);
  assert.equal(reindex.offset, 5000);

  const status = await client.spatial.status("city-assets");
  assert.equal(status.features, 2);

  assert.equal(
    requests[0].url,
    "https://dx.example/v1/capabilities/datasets/city-assets/records/spatial",
  );
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(requests[0].body, {
    mode: "near",
    lat: 21.03,
    lng: 105.85,
    radiusMeters: 500,
    limit: 10,
  });
  assert.equal(requests[0].headers.authorization, "Bearer member");
  assert.equal(
    requests[1].url,
    "https://dx.example/v1/capabilities/datasets/city-assets/records/spatial/reindex",
  );
  assert.equal(requests[1].method, "POST");
  assert.deepEqual(requests[1].body, { offset: 5000 });
  assert.equal(
    requests[2].url,
    "https://dx.example/v1/capabilities/datasets/city-assets/records/spatial/status",
  );
  assert.equal(requests[2].method, "GET");
});

test("dataset create forwards the geo binding", async () => {
  const { impl, requests } = mockFetch(() => ({
    body: { id: "city-assets", slug: "city-assets", geo: { field: "geometry" } },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "member",
    fetch: impl,
  });
  await client.datasets.create({
    slug: "city-assets",
    name: "City assets",
    entityType: "Asset",
    license: "CC-BY-4.0",
    geo: { field: "geometry" },
  });
  assert.deepEqual(requests[0].body, {
    slug: "city-assets",
    name: "City assets",
    entityType: "Asset",
    license: "CC-BY-4.0",
    geo: { field: "geometry" },
  });
});

test("plans methods call the documented EOP orchestration routes", async () => {
  const plan = {
    id: "plan-1",
    tenant: "org-a",
    createdBy: "user-1",
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z",
    title: "Flood response plan",
    objective: "Coordinate flood response.",
    status: "draft",
    phases: [{ id: "p1", title: "Prepare", startOffsetMinutes: 0, tasks: [] }],
  };
  const { impl, requests } = mockFetch((request) => {
    if (request.url.endsWith("/brief")) {
      return {
        body: {
          brief: "Plan is active [T1].",
          citations: [
            {
              index: 1,
              taskId: "task-1",
              phaseId: "p1",
              title: "Confirm roles",
              status: "done",
              dependsOn: [],
            },
          ],
          language: "en",
          model: "fake",
          fallback: false,
          generated_at: "2026-11-15T00:00:00.000Z",
        },
      };
    }
    if (request.url.endsWith("/draft")) {
      return {
        body: {
          planDraft: {
            title: "Draft EOP",
            objective: "Coordinate flood response.",
            phases: [
              { id: "p1", title: "Prepare", startOffsetMinutes: 0, tasks: [] },
            ],
          },
          model: null,
          fallback: true,
          reason: "invalid_json",
        },
      };
    }
    if (request.method === "GET" && request.url.includes("/v1/capabilities/plans")) {
      return {
        body: { items: [], total: 0, limit: 5, offset: 10, nextCursor: null },
      };
    }
    return { body: { plan, version: 2 } };
  });
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "member",
    fetch: impl,
  });

  const created = await client.plans.create({
    title: "Flood response plan",
    objective: "Coordinate flood response.",
    phases: [
      {
        id: "p1",
        title: "Prepare",
        startOffsetMinutes: 0,
        tasks: [
          {
            id: "task-1",
            title: "Confirm roles",
            dueOffsetMinutes: 15,
            dependsOn: [],
          },
        ],
      },
    ],
  });
  assert.equal(created.version, 2);

  const page = await client.plans.list({
    status: "active",
    tenant: "org-a",
    limit: 5,
    offset: 10,
  });
  assert.equal(page.items.length, 0);

  await client.plans.get("plan-1");
  await client.plans.update(
    "plan-1",
    { title: "Revised plan", context: { locale: "vi" } },
    { ifVersion: 2 },
  );
  await client.plans.activate("plan-1");
  await client.plans.pause("plan-1");
  await client.plans.complete("plan-1");
  await client.plans.archive("plan-1");
  await client.plans.taskStatus(
    "plan-1",
    "task-1",
    { status: "in_progress", assignee: "commander-1", override: true },
    { ifVersion: 3 },
  );
  const brief = await client.plans.brief("plan-1", { focus: "flood" });
  const draft = await client.plans.draft({
    objective: "Coordinate flood response.",
    eventType: "flood",
    phaseCount: 3,
  });

  assert.equal(brief.model, "fake");
  assert.equal(brief.citations[0].taskId, "task-1");
  assert.equal(draft.fallback, true);
  assert.equal(draft.reason, "invalid_json");

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url}`),
    [
      "POST https://dx.example/v1/capabilities/plans",
      "GET https://dx.example/v1/capabilities/plans?status=active&tenant=org-a&limit=5&offset=10",
      "GET https://dx.example/v1/capabilities/plans/plan-1",
      "PATCH https://dx.example/v1/capabilities/plans/plan-1",
      "POST https://dx.example/v1/capabilities/plans/plan-1/activate",
      "POST https://dx.example/v1/capabilities/plans/plan-1/pause",
      "POST https://dx.example/v1/capabilities/plans/plan-1/complete",
      "POST https://dx.example/v1/capabilities/plans/plan-1/archive",
      "POST https://dx.example/v1/capabilities/plans/plan-1/tasks/task-1/status",
      "POST https://dx.example/v1/capabilities/plans/plan-1/brief",
      "POST https://dx.example/v1/capabilities/plans/draft",
    ],
  );
  assert.equal(requests[3].headers["if-match"], '"2"');
  assert.equal(requests[8].headers["if-match"], '"3"');
  assert.deepEqual(requests[3].body, {
    title: "Revised plan",
    context: { locale: "vi" },
  });
  assert.deepEqual(requests[8].body, {
    status: "in_progress",
    assignee: "commander-1",
    override: true,
  });
  assert.deepEqual(requests[9].body, { focus: "flood" });
  assert.deepEqual(requests[10].body, {
    objective: "Coordinate flood response.",
    eventType: "flood",
    phaseCount: 3,
  });
});
