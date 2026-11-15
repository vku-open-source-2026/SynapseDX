// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { geometryError } from "./geometry";
import { validateCommonValues } from "./common-builder";
import { materializeActions } from "./studio-actions";
import { parseWidgets, workspaceLimits } from "./workspace-plugins";
test("geometry editors preserve WGS84 shapes and reject malformed, unclosed and oversized input at the server boundary", () => {
  for (const geometry of [{ type: "Point", coordinates: [108, 16] }, { type: "LineString", coordinates: [[108, 16], [109, 16]] }, { type: "Polygon", coordinates: [[[108, 16], [109, 16], [109, 17], [108, 16]]] }]) assert.equal(geometryError(geometry), null);
  for (const geometry of [{ type: "Point", coordinates: [181, 16] }, { type: "Point", coordinates: ["108", 16] }, { type: "LineString", coordinates: [[108, 16]] }, { type: "Polygon", coordinates: [[[108, 16], [109, 16], [109, 17], [108, 17]]] }, { type: "FeatureCollection", features: [] }, { type: "LineString", coordinates: Array.from({ length: 5001 }, () => [108, 16]) }]) {
    assert.ok(geometryError(geometry));
    assert.throws(() => validateCommonValues([{ name: "shape", label: "Area", type: "json", editor: "geometry", required: true }], { shape: geometry }));
  }
  const input = { type: "Point", coordinates: [108, 16] };
  assert.deepEqual(validateCommonValues([{ name: "shape", label: "Area", type: "json", editor: "geometry" }], { shape: input }), { shape: JSON.stringify(input) });
});
test("structured editor configuration round-trips without granting an action or a new data source", () => {
  const widgets = materializeActions<any>([{ id: "create", type: "form", title: "Create", resource: "commonForms", action: "create", fields: [{ name: "schema", label: "Schema", type: "json", editor: "schema", defaultValue: "{}" }] }]);
  const parsed = parseWidgets(widgets, "city", workspaceLimits());
  assert.equal(parsed[0].fields?.[0].editor, "schema");
  assert.throws(() => parseWidgets(widgets.map(w => w.id === "create" ? { ...w, fields: [{ name: "x", label: "Bad", type: "text", editor: "geometry" }] } : w), "city", workspaceLimits()));
  assert.throws(() => validateCommonValues([{ name: "schema", label: "Schema", type: "json", editor: "schema" }], { schema: "[]" }));
});
