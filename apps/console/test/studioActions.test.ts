// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { commonTemplateForSection } from "../src/lib/commonTemplate";
import {
  compileStudioAction,
  defaultActionContext,
  fieldInput,
  resolveActionValues,
  STARTER_ACTION,
} from "../src/lib/studioActionRuntime";
import {
  actionReferenceErrors,
  materializeActions,
  actionGovernanceErrors,
  studioActionError,
  type StudioAction,
} from "../src/lib/studioActions";
import {
  validateWidget,
  toWriteWidget,
  type WorkspaceWidget,
  parseWidgetData,
} from "../src/lib/workspaces";
const widgets: WorkspaceWidget[] = [
  {
    id: "records",
    type: "table",
    title: "Records",
    resource: "assets",
    columns: ["id", "status"],
  },
  {
    id: "edit",
    type: "form",
    title: "Edit",
    resource: "assets",
    action: "update",
    fields: [
      { name: "record_id", label: "ID", type: "text", required: true },
      { name: "status", label: "Status", type: "text" },
      { name: "amount", label: "Amount", type: "number", defaultValue: "5" },
    ],
  },
];
const op: StudioAction = {
  kind: "update",
  target: "edit",
  javascript: "",
  inputs: [],
  actions: [],
  mappings: [
    {
      field: "record_id",
      source: "selected",
      widgetId: "records",
      value: "id",
      required: true,
    },
    {
      field: "status",
      source: "input",
      widgetId: "edit",
      value: "status",
      required: true,
    },
    { field: "amount", source: "literal", value: "0" },
  ],
};
it("each catalog template authors only actions whose targets survive its section filter", () => {
  for (const section of ["tasks", "projects", "workspace", "inbox", "forms", "reports", "ocr", "assistant", "files"]) {
    const widgets = commonTemplateForSection(section);
    expect(actionGovernanceErrors(widgets), section).toEqual([]);
    expect(widgets.filter(w => w.type !== "action").every(w => !w.section || w.section === section)).toBe(true);
  }
});
describe("Studio actions", () => {
  it("maps typed form inputs, a matching selected record and static JSON without interpreting expressions", () => {
    const context = {
      widgets: { edit: { status: "done" } },
      selected: { resource: "assets", row: { id: "asset-1" } },
    };
    expect(resolveActionValues(op, context, widgets)).toEqual({
      record_id: "asset-1",
      status: "done",
      amount: 0,
    });
    expect(defaultActionContext(widgets).widgets.edit.amount).toBe(5);
    expect(
      defaultActionContext([
        {
          ...widgets[1],
          fields: [
            {
              name: "amount",
              label: "Amount",
              type: "number",
              defaultValue: "invalid",
            },
          ],
        },
      ]).widgets.edit.amount,
    ).toBeUndefined();
    expect(fieldInput("checkbox", "false")).toBe(false);
    expect(fieldInput("number", "0")).toBe(0);
    expect(() => fieldInput("number", "bad")).toThrow();
    const code = compileStudioAction(op, context, widgets);
    expect(code.actions).toEqual(["edit"]);
    expect(code.inputs).toEqual([]);
    expect(code.javascript).toContain('studio.action("edit"');
    expect(code.javascript).toContain("studio.result(");
    expect(
      resolveActionValues(
        {
          ...op,
          mappings: [
            {
              field: "status",
              source: "literal",
              value: "{{window.localStorage}}",
            },
          ],
        },
        context,
        widgets,
      ).status,
    ).toBe("{{window.localStorage}}");
  });
  it("refuses missing inputs and a selected record from a different resource", () => {
    expect(() =>
      resolveActionValues(op, { widgets: {}, selected: null }, widgets),
    ).toThrow("Missing input for record_id");
    expect(() =>
      resolveActionValues(
        op,
        {
          widgets: {},
          selected: { resource: "events", row: { id: "event-1" } },
        },
        widgets,
      ),
    ).toThrow("Missing input for record_id");
    expect(() =>
      resolveActionValues(
        op,
        {
          widgets: {},
          selected: { resource: "assets", row: { id: "asset-1" } },
        },
        widgets,
      ),
    ).toThrow("Missing input for status");
    expect(() =>
      compileStudioAction(
        STARTER_ACTION,
        { widgets: { edit: { value: "x".repeat(12001) } }, selected: null },
        widgets,
      ),
    ).toThrow("12000");
  });
  it("preserves action and button settings through the normal draft writer and checks page bindings", () => {
    const actions: WorkspaceWidget[] = [
      ...widgets,
      { id: "update", type: "action", title: "Update", operation: op },
      { id: "save", type: "button", title: "Save", onClick: "update" },
    ];
    expect(actionReferenceErrors(actions)).toEqual([]);
    for (const w of actions)
      expect(validateWidget(toWriteWidget(w))).toEqual([]);
    expect(toWriteWidget(actions[2]).operation).toEqual(op);
    expect(
      actionReferenceErrors([
        ...actions.slice(0, 3),
        { ...actions[3], onClick: "foreign" },
      ])[0],
    ).toMatch(/reference an action/);
    expect(
      actionReferenceErrors([
        { ...actions[2], operation: { ...op, target: "records" } },
      ])[0],
    ).toMatch(/matching update target/);
    expect(
      studioActionError({
        ...op,
        mappings: [{ field: "__proto__", source: "literal", value: "{}" }],
      }),
    ).toMatch(/unique field names/);
    expect(
      studioActionError({ ...op, url: "https://example.com" }),
    ).toBeTruthy();
    expect(
      studioActionError({ ...STARTER_ACTION, javascript: "x".repeat(16001) }),
    ).toBeTruthy();
  });
});

it("keeps query pagination and refuses a selected row from another widget sharing its resource", () => {
  const data = parseWidgetData({ type: "table", items: [{ id: "a" }], columns: ["id"], total: 80, limit: 25, offset: 25 }, "table");
  expect(data).toMatchObject({ limit: 25, offset: 25 });
  expect(() => parseWidgetData({ type: "table", items: [], total: 0, offset: -1 }, "table")).toThrow();
  expect(() => resolveActionValues(op, {
    widgets: { edit: { status: "done" } },
    selected: { resource: "assets", widgetId: "other-table", row: { id: "wrong-record" } },
  }, widgets)).toThrow("Missing input for record_id");
});

it("rejects deep shared chains and excessive repeated execution before runtime writes", () => {
  const chain: WorkspaceWidget[] = [{ id: "leaf", type: "action", title: "Leaf", operation: { ...STARTER_ACTION } }];
  for (let i = 0; i < 14; i++) chain.push({ id: `s-${i}`, type: "action", title: "Step", operation: { ...STARTER_ACTION, kind: "sequence", steps: [i ? `s-${i - 1}` : "leaf"] } });
  expect(actionReferenceErrors(chain).join(" ")).toContain("12");
  expect(actionReferenceErrors([...chain].reverse()).join(" ")).toContain("12");
});

it("migrates old pages to explicit sources and rejects cycles and mutation functions on load", () => {
  const authored = materializeActions(widgets);
  expect(actionGovernanceErrors(authored)).toEqual([]);
  expect(materializeActions(authored)).toEqual(authored);
  const fn: WorkspaceWidget = {
    id: "fn",
    type: "action",
    title: "Unsafe load",
    operation: {
      kind: "function",
      javascript: "",
      mappings: [],
      inputs: ["records"],
      actions: ["edit"],
    },
  };
  expect(
    actionReferenceErrors([
      { ...widgets[0], onLoad: "fn" },
      widgets[1],
      fn,
    ]).join(" "),
  ).toContain("read-only function");
  expect(
    actionReferenceErrors([
      {
        id: "a",
        type: "action",
        title: "A",
        operation: { ...STARTER_ACTION, kind: "sequence", steps: ["a"] },
      },
    ]).join(" "),
  ).toContain("acyclic");
});
it("resolves nested event and previous results, optional mappings and typed transforms", () => {
  expect(
    resolveActionValues(
      {
        ...op,
        mappings: [
          {
            field: "record_id",
            source: "event",
            value: "row.id",
            required: true,
          },
          {
            field: "amount",
            source: "result",
            widgetId: "previous",
            value: "count",
            transform: "number",
          },
          {
            field: "status",
            source: "input",
            widgetId: "edit",
            value: "status",
            transform: "trim",
          },
          { field: "absent", source: "event", value: "absent" },
        ],
      },
      {
        widgets: { edit: { status: " done " } },
        selected: null,
        event: { row: { id: "r1" } },
        results: { previous: { count: "12" } },
      },
      widgets,
    ),
  ).toEqual({ record_id: "r1", amount: 12, status: "done" });
});
