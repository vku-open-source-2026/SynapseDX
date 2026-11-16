// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { validateFormSchema, validateFormValues } from "./form-schema";
import { api, startHarness } from "./testing/harness";

test("native schema controls enforce nested types, formats, limits and undeclared fields without coercing inputs", () => {
  const schema = {
    type: "object", required: ["email", "count", "location"], additionalProperties: false,
    properties: {
      email: { type: "string", format: "email", minLength: 5 },
      count: { type: "integer", minimum: 1, maximum: 3 },
      location: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string", maxLength: 8 } } },
      tags: { type: "array", uniqueItems: true, items: { type: "string", enum: ["city", "team"] } },
      website: { type: "string", format: "uri" },
      date: { type: "string", format: "date" },
    },
  };
  validateFormSchema(schema);
  const valid = { email: "member@example.com", count: 2, location: { name: "Office" }, tags: ["city"], website: "https://example.com", date: "2026-11-15" };
  assert.deepEqual(validateFormValues(schema, valid), []);
  for (const patch of [{ email: "wrong" }, { count: 1.5 }, { count: "2" }, { count: 4 }, { location: [] }, { location: { name: "Far too long" } }, { location: { name: "HQ", secret: true } }, { tags: ["city", "city"] }, { website: "invalid" }, { date: "2026-02-31" }, { unknown: true }]) {
    assert.ok(validateFormValues(schema, { ...valid, ...patch }).length, JSON.stringify(patch));
  }
  assert.equal(valid.count, 2);
  for (const schema of [
    { type: "object", properties: null },
    { type: "object", properties: { name: { type: "string", pattern: "[" } } },
    { type: "object", properties: { name: { $ref: "https://example.com/schema.json" } } },
    { type: "object", properties: {}, $async: true },
  ]) assert.throws(() => validateFormSchema(schema));
});

test("form validation uses draft-7 local references and keeps existing conditional visibility semantics", () => {
  const schema = {
    type: "object", required: ["needed", "reason"], additionalProperties: false,
    definitions: { reason: { type: "string", minLength: 3 } },
    properties: { needed: { type: "boolean" }, reason: { $ref: "#/definitions/reason", visibleWhen: { field: "needed", equals: true } } },
  };
  validateFormSchema(schema);
  assert.deepEqual(validateFormValues(schema, { needed: false }), []);
  assert.deepEqual(validateFormValues(schema, { needed: false, reason: 1 }), []);
  assert.ok(validateFormValues(schema, { needed: true }).some(error => error.includes("reason")));
  assert.ok(validateFormValues(schema, { needed: true, reason: "ab" }).length);
  assert.deepEqual(validateFormValues(schema, { needed: true, reason: "Help" }), []);
});

test("the actual app-scoped form routes enforce designer validation and reject malformed schemas before saving", async () => {
  const h = await startHarness();
  try {
    const grant = await api(h, "/v1/capabilities/workspaces/members/member-1", { method: "PUT", token: "admin-token", body: { productRoles: { city: ["manager"] } } });
    assert.equal(grant.status, 200);
    const request = (path: string, body: unknown) => api(h, `/v1/capabilities/forms${path}`, { method: "POST", token: "member-token", headers: { "X-Workspace-App": "city" }, body });
    const created = await request("", { name: "Inspection", schema: { type: "object", additionalProperties: false, required: ["email", "count"], properties: { email: { type: "string", format: "email" }, count: { type: "integer", minimum: 1 } } } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const path = `/${created.body.form.id}/validate`;
    assert.equal((await request(path, { values: { email: "invalid", count: 1.5 } })).body.valid, false);
    assert.equal((await request(path, { values: { email: "member@example.com", count: 2 } })).body.valid, true);
    assert.equal((await request("", { name: "Invalid", schema: { type: "object", properties: { name: { type: "strng" } } } })).status, 400);
    const crossApp = await api(h, `/v1/capabilities/forms${path}`, { method: "POST", token: "member-token", headers: { "X-Workspace-App": "sos" }, body: { values: {} } });
    assert.equal(crossApp.status, 403);
  } finally { await h.close(); }
});
