// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mapCsv, parseCsv, csvCell } from "./tabular";
import { api, apiBinary, createDataset, startHarness } from "./testing/harness";

test("strict CSV supports BOM, escaped quotes and embedded newlines, and rejects malformed files", () => {
  const csv = parseCsv('\ufeffid,name\r\nA,"A, \"\"bridge\"\"\nline"\r\n');
  assert.deepEqual(csv, { headers: ["id", "name"], rows: [["A", 'A, "bridge"\nline']] });
  for (const text of ['id,id\na,b', 'id,name\na', 'id,name\na,"broken', 'id,name\na,b"c', 'id,name\na,"b"c']) assert.throws(() => parseCsv(text));
  assert.equal(csvCell("=SUM(A1)"), '"\'=SUM(A1)"');
  assert.throws(() => mapCsv(parseCsv('id\na'), { columns: [{ column: "id", field: "__proto__.x" }] }));
});

test("native table files preview, import actual records with typed geometry, resume idempotently and generate downloadable artifacts", async () => {
  const h = await startHarness(); h.config.publicUrl = h.base;
  const headers = { "x-workspace-app": "city" };
  try {
    await api(h, "/v1/capabilities/workspaces/members/member-1", { token: "admin-token", method: "PUT", body: { productRoles: { city: ["volunteer"] } } });
    const ds = await createDataset(h, { slug: "city-assets", public: false }, { token: "admin-token" });
    assert.equal(ds.status, 201);
    const content = 'id,name,lat,lng\nA,Bridge,16,108\nB,Invalid,200,108\nC,Lamp,16.1,108.2\n';
    const file = await api(h, "/v1/capabilities/files", { token: "admin-token", method: "POST", headers, body: { filename: "assets.csv", contentType: "text/csv" } });
    const id = file.body.id;
    assert.equal((await api(h, `/v1/capabilities/files/${id}/content`, { token: "admin-token", method: "PUT", headers: { ...headers, "content-type": "text/csv" }, buffer: Buffer.from(content) })).status, 200);
    const schema = { columns: [{ column: "id", field: "asset_code", required: true }, { column: "name", field: "name", required: true }, { column: "lat", field: "latitude", type: "number", required: true, min: -90, max: 90 }, { column: "lng", field: "longitude", type: "number", required: true, min: -180, max: 180 }], defaults: { type: "Asset", status: "active" }, idField: "asset_code", point: { latitude: "latitude", longitude: "longitude", target: "geometry" } };
    const preview = await api(h, `/v1/capabilities/files/${id}/tabular/preview`, { token: "member-token", method: "POST", headers, body: { schema } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.validRows, 2); assert.equal(preview.body.invalidRows, 1); assert.equal(preview.body.errors[0].row, 3);
    const request = { datasetId: "city-assets", schema, publish: false, limit: 2, offset: 0 };
    const run = (body = request) => api(h, `/v1/capabilities/files/${id}/tabular/import`, { apiKey: "workflow-org-key", method: "POST", headers, body });
    assert.equal((await api(h, `/v1/capabilities/files/${id}/tabular/import`, { token: "member-token", method: "POST", headers, body: request })).status, 403);
    const first = await run();
    assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.imported, 1); assert.equal(first.body.invalid, 1); assert.equal(first.body.nextOffset, 2);
    const repeated = await run(); assert.equal(repeated.body.imported, 0); assert.equal(repeated.body.skipped, 1);
    const last = await run({ ...request, offset: 2 }); assert.equal(last.body.imported, 1); assert.equal(last.body.nextOffset, undefined);
    assert.equal((await run({ ...request, offset: 4 })).status, 400, "a resume offset beyond the file must not report negative processed rows");
    const record = await api(h, "/v1/capabilities/datasets/city-assets/records/A", { token: "admin-token" });
    assert.deepEqual(record.body.data.geometry, { type: "Point", coordinates: [108, 16] });
    assert.equal((await run({ ...request, datasetId: "sos-emergency-events" })).status, 403);
    const foreign = await api(h, `/v1/capabilities/files/${id}/tabular/preview`, { apiKey: "workflow-org-key", method: "POST", headers: { "x-workspace-app": "sos" }, body: {} }); assert.equal(foreign.status, 404);
    const artifact = await api(h, "/v1/capabilities/files/tabular/render", { apiKey: "workflow-org-key", method: "POST", headers, body: { filename: "report.csv", format: "csv", columns: ["name", "cost"], rows: [{ name: "=injection", cost: 15 }] } });
    assert.equal(artifact.status, 201, JSON.stringify(artifact.body)); assert.equal(artifact.body.rowCount, 1); assert.ok(artifact.body.checksumSha256);
    const bytes = await apiBinary(h, `/v1/capabilities/files/${artifact.body.file_id}/content`, { token: "member-token", headers });
    assert.equal(bytes.status, 200); assert.equal(bytes.body.toString(), '"name","cost"\r\n"\'=injection","15"\r\n');
    assert.equal((await api(h, "/v1/capabilities/files/tabular/render", { token: "admin-token", method: "POST", headers, body: { filename: "fake.pdf", format: "pdf", columns: ["x"], rows: [] } })).status, 415);
  } finally { await h.close(); }
});

test("generated reports include every filtered page and evaluate declared columns without leaking the other app", async () => {
  const h = await startHarness(); h.config.publicUrl = h.base; h.config.maxPageSize = 2;
  const headers = { "x-workspace-app": "city" };
  try {
    assert.equal((await createDataset(h, { slug: "city-maintenance", public: false }, { token: "admin-token" })).status, 201);
    for (let i = 0; i < 7; i++) assert.equal((await api(h, "/v1/capabilities/datasets/city-maintenance/records", { token: "admin-token", method: "POST", body: { id: `order-${i}`, data: { title: `Inspection ${i}`, status: i === 6 ? "cancelled" : "completed", cost: i + 1 }, publish: false } })).status, 201);
    const body = { datasetId: "city-maintenance", filename: "complete.json", format: "json", where: { status: "completed" }, columns: [{ name: "order", value: { field: "id" } }, { name: "total", value: { op: "multiply", args: [{ field: "cost" }, { literal: 2 }] } }] };
    const report = await api(h, "/v1/capabilities/files/tabular/export", { apiKey: "workflow-org-key", headers, method: "POST", body });
    assert.equal(report.status, 201, JSON.stringify(report.body)); assert.equal(report.body.rowCount, 6);
    const downloaded = await apiBinary(h, `/v1/capabilities/files/${report.body.file_id}/content`, { token: "admin-token", headers });
    const rows = JSON.parse(downloaded.body.toString()).rows;
    assert.deepEqual(rows.map((r: any) => r.order), Array.from({ length: 6 }, (_, i) => `order-${i}`));
    assert.deepEqual(rows.map((r: any) => r.total), [2, 4, 6, 8, 10, 12]);
    assert.equal((await api(h, "/v1/capabilities/files/tabular/export", { apiKey: "workflow-org-key", headers, method: "POST", body: { ...body, datasetId: "sos-dispatch-orders" } })).status, 400);
  } finally { await h.close(); }
});
