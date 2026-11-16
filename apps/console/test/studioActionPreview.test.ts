// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { simulateStudioAction, compileStudioActionPreview } from "../src/lib/studioActionPreview";
import type { StudioAction } from "../src/lib/studioActions";
import type { WorkspaceWidget } from "../src/lib/workspaces";
const op = (kind: StudioAction["kind"], settings: Partial<StudioAction> = {}): StudioAction => ({ kind, mappings: [], javascript: "", inputs: [], actions: [], ...settings });
const action = (id: string, operation: StudioAction): WorkspaceWidget => ({ id, type: "action", title: id, operation });
const initial = { widgets: {}, selected: null };
describe("native Studio action simulation", () => {
  it("executes ordered steps, branches, input changes and prior results without network", async () => {
    const widgets: WorkspaceWidget[] = [
      { id: "form", type: "form", title: "Form", fields: [{ name: "quantity", label: "Quantity", type: "number", defaultValue: "2" }] },
      action("set", op("setValues", { target: "form", mappings: [{ field: "quantity", source: "literal", value: "9" }] })),
      action("check", op("condition", { mappings: [{ field: "value", source: "input", widgetId: "form", value: "quantity" }], comparison: "greater", compareValue: "5", then: "create", otherwise: "miss" })),
      action("create", op("create", { target: "form", mappings: [{ field: "quantity", source: "input", widgetId: "form", value: "quantity", required: true }] })),
      action("copy", op("setValues", { target: "form", mappings: [{ field: "quantity", source: "result", widgetId: "create", value: "values.quantity" }] })),
      action("reset", op("resetForm", { target: "form" })),
      action("miss", op("notify", { message: "Wrong branch" })),
    ];
    const result = await simulateStudioAction(op("sequence", { steps: ["set", "check", "copy", "reset"] }), initial, widgets, {});
    expect(result.trace.map(step => step.id)).toEqual(["preview-root", "set", "check", "create", "copy", "reset"]);
    expect(result.context.widgets.form).toEqual({ quantity: 2 });
    expect(result.context.results?.create).toMatchObject({ values: { quantity: 9 }, preview: true });
    expect(initial.widgets).toEqual({});
  });
  it("simulates reference queries with mapped filters, sorting and pagination", async () => {
    const widgets: WorkspaceWidget[] = [{ id: "form", type: "form", title: "Task", fields: [{ name: "project", label: "Project", type: "select", optionsResource: "commonProjects" }] }];
    const result = await simulateStudioAction(op("query", { target: "form", source: "commonProjects", mappings: [{ field: "status", source: "literal", value: "active" }, { field: "limit", source: "literal", value: "1" }] }), initial, widgets, { "form.project": { items: [{ id: "a", name: "Active", status: "active" }, { id: "b", name: "Closed", status: "closed" }] } });
    expect(result.result).toEqual({ items: [{ value: "a", label: "Active" }], total: 1, offset: 0, limit: 1 });
  });
  it("rejects missing required mappings and cyclic action graphs", async () => {
    await expect(simulateStudioAction(op("condition", { mappings: [{ field: "value", source: "event", value: "missing", required: true }], comparison: "exists", then: "x" }), initial, [], {})).rejects.toThrow("Missing input");
    await expect(simulateStudioAction(op("sequence", { steps: ["loop"] }), initial, [action("loop", op("sequence", { steps: ["loop"] }))], {})).rejects.toThrow("chain limits");
  });
  it("compiles the same tested interpreter and executes JavaScript steps within sandbox source", async () => {
    const native = op("sequence", { steps: ["fn", "message"] });
    const widgets = [action("fn", op("function", { javascript: 'async function run(input, studio) { return { answer: 42 }; }' })), action("message", op("notify", { message: "Done" }))];
    const code = compileStudioActionPreview(native, initial, widgets, {});
    let result: any;
    // Test-only execution of compiler output. Product evaluation stays inside Studio's isolated worker.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction("studio", code.javascript)({ result: (value: any) => { result = value; }, render: () => {} });
    expect(result.context.results.fn.answer).toBe(42);
    expect(result.trace.map((step: any) => step.kind)).toEqual(["sequence", "function", "notify"]);
  });
  it("restricts each preview function to its own declared bindings", async () => {
    const root = op("function", { javascript: 'async function run(input, studio) { return studio.query("secret"); }' });
    const code = compileStudioActionPreview(root, initial, [], { secret: { rows: [] } });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await expect(new AsyncFunction("studio", code.javascript)({ result: () => {}, render: () => {} })).rejects.toThrow("Undeclared query");
  });
});
