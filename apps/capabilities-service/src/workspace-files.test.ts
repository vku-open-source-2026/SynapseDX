// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { api, startHarness } from "./testing/harness";
import { materializeActions, actionGovernanceErrors } from "./studio-actions";

const widgets: any[] = materializeActions<any>([
  { id: "files", type: "table", title: "Files", resource: "commonFiles", columns: ["filename", "size"] },
  { id: "upload", type: "form", title: "Upload", resource: "commonFiles", action: "execute", fields: [{ name: "file_id", label: "File", type: "file", accept: "application/json,text/csv", maxBytes: 1024, required: true }] },
  { id: "download", type: "action", title: "Download", operation: { kind: "download", target: "files", mappings: [{ field: "file_id", source: "selected", widgetId: "files", value: "id", required: true }], inputs: [], actions: [], javascript: "" } },
]);
test("native files require a matching published action and keep exact binary bytes inside their app", async () => {
  assert.deepEqual(actionGovernanceErrors(widgets), []);
  const h = await startHarness(); h.config.publicUrl = h.base;
  try {
    const base = "/v1/capabilities/workspaces";
    const admin = (path: string, method = "GET", body?: any) => api(h, base + path, { token: "admin-token", method, body });
    await admin("/members/member-1", "PUT", { productRoles: { city: ["volunteer"], sos: ["volunteer"] } });
    await admin("/members/moderator-1", "PUT", { productRoles: { city: ["volunteer"] } });
    const ids: Record<string, string> = {};
    for (const product of ["city", "sos"]) {
      const created = await admin("/plugins", "POST", { product, name: "File workspace", slug: `${product}-file-workspace`, audience: "member", roles: ["volunteer"], widgets });
      assert.equal(created.status, 201, JSON.stringify(created.body)); ids[product] = created.body.id;
      assert.equal((await admin(`/plugins/${ids[product]}/publish`, "POST")).status, 200);
      assert.equal((await admin(`/plugins/${ids[product]}/install`, "POST", { roles: ["volunteer"] })).status, 201);
    }
    const path = (product: string, action = "act-upload-upload-file-id") => `${base}/installed/${ids[product]}/widgets/upload/upload?action=${action}`;
    const send = (product: string, action?: string, type = "application/json", bytes = Buffer.from('{"document":"đường phố","nul":"\\u0000"}')) => api(h, path(product, action), { token: "member-token", method: "POST", headers: { "content-type": type, "x-file-name": encodeURIComponent("Tài liệu.json") }, buffer: bytes });
    assert.equal((await send("city", "missing")).status, 403);
    assert.equal((await send("city", undefined, "image/png")).status, 415);
    assert.equal((await send("city", undefined, "application/json", Buffer.alloc(1025))).status, 413);
    const uploaded = await send("city");
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.ok(uploaded.body.checksumSha256);
    const fileId = uploaded.body.id;
    const submit = await api(h, `${base}/installed/${ids.city}/widgets/upload/execute?action=act-upload-submit`, { token: "member-token", method: "POST", body: { values: { file_id: fileId } } });
    assert.equal(submit.status, 200, JSON.stringify(submit.body));
    const download = async (product: string, token = "member-token", action = "download") => fetch(h.base + `${base}/installed/${ids[product]}/widgets/files/download?action=${action}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ values: { file_id: fileId } }) });
    const response = await download("city");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"document":"đường phố","nul":"\\u0000"}');
    assert.equal((await download("city", "member-token", "missing")).status, 403);
    assert.equal((await download("sos")).status, 404, "same organization membership must not expose the other app's file");
    assert.equal((await download("sos", "moderator-token")).status, 404);
    const forged = await api(h, `${base}/installed/${ids.sos}/widgets/upload/execute?action=act-upload-submit`, { token: "member-token", method: "POST", body: { values: { file_id: fileId } } });
    assert.equal(forged.status, 404, "file IDs cannot cross app boundaries in form submissions");
    const list = await api(h, `${base}/installed/${ids.city}/widgets/files/data?action=act-files-load`, { token: "member-token" });
    assert.equal(list.body.items.length, 1);
    // Verified org admins also require explicit app context to inspect common files.
    const adminOtherApp = await api(h, `/v1/capabilities/files/${fileId}`, { token: "admin-token", headers: { "x-workspace-app": "sos" } });
    assert.equal(adminOtherApp.status, 404);
  } finally { await h.close(); }
});
