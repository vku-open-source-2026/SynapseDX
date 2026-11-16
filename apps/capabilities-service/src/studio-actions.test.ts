import {
  materializeActions,
  actionGovernanceErrors,
  registeredBinding,
  actionPayloadError,
} from "./studio-actions";
// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWidgets,
  workspaceLimits,
  buildBundle,
  parseBundle,
  type WorkspacePluginRecord,
  type WorkspaceWidget,
} from "./workspace-plugins";
import { api, startHarness } from "./testing/harness";
const operation = {
  kind: "function" as const,
  mappings: [],
  javascript:
    'async function run(input, studio) { throw new Error("Never evaluate on server"); }',
  inputs: ["records"],
  actions: ["create"],
};
const widgets: WorkspaceWidget[] = [
  {
    id: "records",
    type: "table",
    title: "Records",
    resource: "commonProjects",
    columns: ["name"],
  },
  {
    id: "create",
    type: "form",
    title: "Create",
    resource: "commonProjects",
    action: "create",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "startDate", label: "Start date", type: "date", required: true },
      { name: "endDate", label: "End date", type: "date", required: true },
    ],
  },
  { id: "function", type: "action", title: "Function", operation },
  { id: "button", type: "button", title: "Create", onClick: "function" },
];
test("named actions and button events round-trip, reject cross-page references, wrong operations and prototype fields", () => {
  const parsed = parseWidgets(widgets, "city", workspaceLimits());
  const bundle = buildBundle({
    product: "city",
    name: "Actions",
    slug: "action-page",
    audience: "member",
    roles: ["volunteer"],
    widgets: parsed,
  } as WorkspacePluginRecord);
  assert.deepEqual(
    parseBundle(bundle, workspaceLimits()).plugin.widgets,
    parsed,
  );
  for (const op of [
    { ...operation, inputs: ["foreign"] },
    { ...operation, actions: ["records"] },
    { ...operation, javascript: "x".repeat(16001) },
    { ...operation, url: "https://example.com" },
    { ...operation, kind: "update", target: "create" },
    {
      ...operation,
      kind: "create",
      target: "create",
      mappings: [{ field: "__proto__", source: "literal", value: "{}" }],
    },
    {
      ...operation,
      kind: "create",
      target: "create",
      mappings: [
        { field: "name", source: "input", widgetId: "foreign", value: "name" },
      ],
    },
  ])
    assert.throws(() =>
      parseWidgets(
        [...widgets.slice(0, 2), { ...widgets[2], operation: op }, widgets[3]],
        "city",
        workspaceLimits(),
      ),
    );
  assert.throws(() =>
    parseWidgets(
      [...widgets.slice(0, 3), { ...widgets[3], onClick: "foreign" }],
      "city",
      workspaceLimits(),
    ),
  );
  assert.throws(() =>
    parseWidgets(
      [{ ...widgets[2], operation, resource: "assets" }],
      "city",
      workspaceLimits(),
    ),
  );
});
test("actions remain declarative through save/publish/install; existing authorized form endpoint owns execution and app isolation", async () => {
  const h = await startHarness();
  h.config.publicUrl = h.base; // Explicit test-only self-forwarding.
  try {
    const base = "/v1/capabilities/workspaces";
    const admin = (path: string, method = "GET", body?: unknown) =>
      api(h, base + path, {
        method,
        token: "admin-token",
        ...(body ? { body } : {}),
      });
    const member = (
      path: string,
      method = "GET",
      body?: unknown,
      token = "member-token",
    ) => api(h, base + path, { method, token, ...(body ? { body } : {}) });
    await admin("/members/member-1", "PUT", {
      productRoles: { city: ["volunteer"] },
    });
    const ids: Record<string, string> = {};
    for (const product of ["city", "sos"]) {
      const created = await admin("/plugins", "POST", {
        product,
        name: "Actions",
        slug: "actions-" + product,
        audience: "member",
        roles: ["volunteer"],
        widgets: materializeActions(widgets),
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      ids[product] = created.body.id;
      assert.deepEqual(
        created.body.widgets.find((w: any) => w.type === "action").operation,
        operation,
      );
      assert.equal(
        (await admin(`/plugins/${ids[product]}/publish`, "POST")).status,
        200,
      );
      assert.equal(
        (
          await admin(`/plugins/${ids[product]}/install`, "POST", {
            roles: ["volunteer"],
          })
        ).status,
        201,
      );
    }
    const installed = await member("/installed");
    assert.deepEqual(
      installed.body.items.map((p: any) => p.product),
      ["city"],
    );
    assert.deepEqual(
      installed.body.items[0].widgets.find((w: any) => w.type === "action")
        .operation,
      operation,
    );
    const exec = `/installed/${ids.city}/widgets/create/execute?action=function`;
    const denied = await member(exec.split("?")[0], "POST", {
      values: { name: "Hidden execution" },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "action_not_registered");
    assert.equal(
      (await member(`/installed/${ids.city}/widgets/records/data`)).status,
      403,
    );
    assert.equal(
      (
        await member(
          `/installed/${ids.city}/widgets/records/data?action=function`,
        )
      ).status,
      200,
    );
    const result = await member(exec, "POST", {
      values: {
        name: "Created through action binding",
        startDate: "2026-11-01",
        endDate: "2026-12-01",
      },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(
      (
        await member(`/installed/${ids.sos}/widgets/create/execute`, "POST", {
          values: { name: "Must fail" },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await member(
          `/installed/${ids.city}/widgets/function/execute?action=function`,
          "POST",
          { values: {} },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await member(
          exec,
          "POST",
          { values: { name: "Must fail" } },
          "other-token",
        )
      ).status,
      404,
    );
    assert.equal(
      (await admin(`/plugins/${ids.city}/export`)).body.plugin.widgets.find(
        (w: any) => w.type === "action",
      ).operation.javascript,
      operation.javascript,
    );
    assert.equal(
      (
        await api(h, base + `/plugins/${ids.city}`, {
          method: "PUT",
          token: "member-token",
          body: { version: 1, name: "Forbidden" },
        })
      ).status,
      403,
    );
  } finally {
    await h.close();
  }
});

test("actions have a separate capacity so a 64-component page can still define functions", () => {
  const components = Array.from({ length: 64 }, (_, i) => ({
    id: `text-${i}`,
    type: "text",
    title: "Text",
    text: "",
  }));
  const actions = Array.from({ length: 128 }, (_, i) => ({
    id: `action-${i}`,
    type: "action",
    title: "Action",
    operation: {
      kind: "function",
      mappings: [],
      inputs: [],
      actions: [],
      javascript: "async function run() { return null; }",
    },
  }));
  assert.equal(
    parseWidgets([...components, ...actions], "city", workspaceLimits()).length,
    192,
  );
  assert.throws(() =>
    parseWidgets(
      [...components, { ...components[0], id: "overflow" }],
      "city",
      workspaceLimits(),
    ),
  );
  assert.throws(() =>
    parseWidgets(
      [...actions, { ...actions[0], id: "overflow" }],
      "city",
      workspaceLimits(),
    ),
  );
});

test("governance materializes legacy sources and events once, denies undeclared bindings and fixed payload tampering", () => {
  const authored = materializeActions(widgets);
  assert.deepEqual(actionGovernanceErrors(authored), []);
  assert.deepEqual(materializeActions(authored), authored);
  const table = authored.find((w) => w.id === "records")!;
  assert.equal(
    registeredBinding(authored, undefined, "records", "query"),
    null,
  );
  assert.equal(
    registeredBinding(authored, "unknown", "records", "query"),
    null,
  );
  assert.equal(
    registeredBinding(authored, table.onLoad, "records", "query")?.source,
    "commonProjects",
  );
  assert.equal(
    registeredBinding(authored, table.onLoad, "create", "mutation"),
    null,
  );
  const op = {
    kind: "update" as const,
    target: "create",
    javascript: "",
    inputs: [],
    actions: [],
    mappings: [{ field: "status", source: "literal" as const, value: "done" }],
  };
  assert.equal(actionPayloadError(op, { status: "done" }), null);
  assert.match(
    actionPayloadError(op, { status: "admin" })!,
    /cannot be overridden/,
  );
  assert.match(
    actionPayloadError(op, { status: "done", tenant: "other" })!,
    /not declared/,
  );
  const rogue = authored.map((w) =>
    w.id === table.onLoad
      ? { ...w, operation: { ...w.operation!, source: "sos-secret" } }
      : w,
  );
  assert.ok(
    actionGovernanceErrors(rogue).some((e) => e.includes("catalog source")),
  );
});

test("publish requires governed reads and server execution rejects forged preset values before downstream writes", async () => {
  const h = await startHarness();
  h.config.publicUrl = h.base;
  const base = "/v1/capabilities/workspaces";
  const request = (path: string, method = "GET", body?: unknown) =>
    api(h, base + path, {
      token: "admin-token",
      method,
      ...(body ? { body } : {}),
    });
  try {
    const plugin = {
      product: "city",
      name: "Governance",
      slug: "governance-test",
      audience: "admin",
      roles: ["admin"],
      widgets: widgets.slice(0, 2),
    };
    const draft = await request("/plugins", "POST", plugin);
    assert.equal(draft.status, 201);
    const denied = await request(`/plugins/${draft.body.id}/publish`, "POST");
    assert.equal(denied.status, 400);
    assert.equal(denied.body.error.code, "action_governance");
    const authored = materializeActions(widgets.slice(0, 2));
    const submit = authored.find(
      (w) => w.id === authored.find((w) => w.id === "create")!.onSubmit,
    )!;
    submit.operation!.mappings = submit.operation!.mappings.map((m) =>
      m.field === "name"
        ? { ...m, source: "literal", value: "Reviewed project" }
        : m,
    );
    const query = authored.find(
      (w) => w.id === authored.find((w) => w.id === "records")!.onLoad,
    )!;
    query.operation!.mappings = [
      { field: "limit", source: "literal", value: "25" },
    ];
    const saved = await request(`/plugins/${draft.body.id}`, "PUT", {
      ...plugin,
      product: undefined,
      version: draft.body.version,
      widgets: authored,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(
      (await request(`/plugins/${draft.body.id}/publish`, "POST")).status,
      200,
    );
    assert.equal(
      (await request(`/plugins/${draft.body.id}/install`, "POST")).status,
      201,
    );
    const target = `/installed/${draft.body.id}/widgets/`;
    const before = h.fake.requests.filter(
      (r) => r.method === "POST" && r.path.includes("/projects"),
    ).length;
    assert.equal(
      (
        await request(target + `create/execute?action=${submit.id}`, "POST", {
          values: {
            name: "Injected",
            startDate: "2026-11-01",
            endDate: "2026-12-01",
          },
        })
      ).status,
      400,
    );
    assert.equal(
      (await request(target + `records/data?action=${query.id}&limit=100`))
        .status,
      400,
    );
    assert.equal(
      (await request(target + `records/data?action=${query.id}&limit=25`))
        .status,
      200,
    );
    assert.equal(
      h.fake.requests.filter(
        (r) => r.method === "POST" && r.path.includes("/projects"),
      ).length,
      before,
    );
  } finally {
    await h.close();
  }
});
