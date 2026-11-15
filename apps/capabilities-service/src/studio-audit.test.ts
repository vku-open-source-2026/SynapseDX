// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { actionReferenceErrors, materializeActions, type StudioAction } from "./studio-actions";
import { validateCommonValues } from "./common-builder";
import { api, startHarness, createDataset } from "./testing/harness";
import type { WorkspaceWidget } from "./workspace-plugins";

const preset = (kind: StudioAction["kind"], extra: Partial<StudioAction> = {}): StudioAction => ({
  kind, mappings: [], javascript: "", inputs: [], actions: [], ...extra,
});
test("chain depth is independent of declaration order and repeated steps have a bounded cost", () => {
  const chain: WorkspaceWidget[] = [{ id: "leaf", type: "action", title: "Leaf", operation: preset("notify", { message: "Done" }) }];
  for (let i = 0; i < 14; i++) chain.push({
    id: `step-${i}`, type: "action", title: "Sequence",
    operation: preset("sequence", { steps: [i ? `step-${i - 1}` : "leaf"] }),
  });
  for (const ordered of [chain, [...chain].reverse()])
    assert.match(actionReferenceErrors(ordered).join(" "), /12/);
  const fanout: WorkspaceWidget[] = [chain[0]];
  for (let i = 0; i < 4; i++) fanout.push({
    id: `repeat-${i}`, type: "action", title: "Repeated sequence",
    operation: preset("sequence", { steps: Array(10).fill(i ? `repeat-${i - 1}` : "leaf") }),
  });
  assert.match(actionReferenceErrors(fanout).join(" "), /128/);
});
test("JSON action transforms accept structured values only in declared JSON fields", () => {
  const fields = [{ name: "payload", label: "Payload", type: "json" as const }];
  assert.deepEqual(validateCommonValues(fields, { payload: { labels: ["a", "b"] } }), { payload: '{"labels":["a","b"]}' });
  assert.throws(() => validateCommonValues([{ ...fields[0], type: "text" }], { payload: { labels: [] } }));
});
test("reference queries enforce fixed mappings, filters, pagination and app isolation; metric status filters reach persistence", async () => {
  const h = await startHarness();
  h.config.publicUrl = h.base; // Explicit test-only forwarding to the harness.
  try {
    const request = (path: string, method = "GET", body?: unknown, token = "admin-token") => api(h, "/v1/capabilities/" + path, { method, token, ...(body ? { body } : {}) });
    await request("workspaces/members/member-1", "PUT", { productRoles: { city: ["volunteer"] } });
    const widgets = materializeActions<WorkspaceWidget>([
      { id: "projects", type: "form", title: "New project", resource: "commonProjects", action: "create", fields: [
        { name: "name", type: "text", label: "Name", required: true },
        { name: "startDate", type: "date", label: "Start", required: true },
        { name: "endDate", type: "date", label: "End", required: true },
      ] },
      { id: "tasks", type: "form", title: "New task", resource: "commonTasks", action: "create", fields: [
        { name: "projectId", label: "Project", type: "select", optionsResource: "commonProjects", optionsAction: "project-options" },
      ] },
      { id: "project-options", type: "action", title: "Filtered projects", operation: preset("query", {
        target: "tasks", source: "commonProjects", mappings: [
          { field: "search", source: "literal", value: "Visible" },
          { field: "limit", source: "literal", value: "1" },
          { field: "offset", source: "event", value: "offset" },
        ],
      }) },
      { id: "active-count", type: "metric", title: "Active assets", resource: "assets", onLoad: "active-query" },
      { id: "active-query", type: "action", title: "Active assets query", operation: preset("query", {
        target: "active-count", source: "assets", mappings: [{ field: "status", source: "literal", value: "active" }, { field: "search", source: "event", value: "search" }],
      }) },
      { id: "asset-records", type: "table", title: "Asset identifiers", resource: "assets", columns: ["id"] },
    ]);
    const created = await request("workspaces/plugins", "POST", { product: "city", slug: "audit-query", name: "Audit query", roles: ["volunteer"], audience: "member", widgets });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;
    assert.equal((await request(`workspaces/plugins/${id}/publish`, "POST")).status, 200);
    assert.equal((await request(`workspaces/plugins/${id}/install`, "POST", { roles: ["volunteer"] })).status, 201);
    const member = (path: string, method = "GET", body?: unknown) => request(`workspaces/installed/${id}/widgets/${path}`, method, body, "member-token");
    for (const name of ["Hidden", "Visible A", "Visible B"]) {
      const result = await member(`projects/execute?action=${widgets.find(w => w.id === "projects")!.onSubmit}`, "POST", { values: { name, startDate: "2026-11-01", endDate: "2026-12-01" } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    const endpoint = "tasks/options/projectId?action=project-options";
    assert.equal((await member(endpoint)).status, 400, "Omitted fixed query values must be rejected");
    assert.equal((await member(endpoint + "&search=Hidden&limit=1")).status, 400, "A caller must not override the published filter");
    const first = await member(endpoint + "&search=Visible&limit=1");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.total, 2);
    assert.equal(first.body.items.length, 1);
    assert.match(first.body.items[0].label, /^Visible/);
    const second = await member(endpoint + "&search=Visible&limit=1&offset=1");
    assert.notEqual(first.body.items[0].value, second.body.items[0].value);
    assert.equal((await request(`workspaces/installed/${id}/widgets/${endpoint}&search=Visible&limit=1`, "GET", undefined, "other-token")).status, 404);
    assert.equal((await createDataset(h, { slug: "city-assets", name: "Assets", public: true }, { token: "admin-token" })).status, 201);
    let recordId = "";
    for (const status of ["active", "retired"]) {
      const record = await request("datasets/city-assets/records", "POST", { data: { status } });
      assert.equal(record.status, 201, JSON.stringify(record.body));
      recordId = record.body.id;
    }
    const metric = await member("active-count/data?action=active-query&status=active");
    assert.equal(metric.status, 200, JSON.stringify(metric.body));
    assert.equal(metric.body.count, 1, "Fixed status must filter records even if not a visible column");
    assert.equal((await member("active-count/data?action=active-query&status=active&search=ignored")).status, 400, "Search without published columns must never silently return unfiltered records");
    const byId = await member(`asset-records/data?action=act-asset-records-load&search=${recordId}`);
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.total, 1);
    assert.equal(byId.body.items[0].id, recordId);
  } finally { await h.close(); }
});
