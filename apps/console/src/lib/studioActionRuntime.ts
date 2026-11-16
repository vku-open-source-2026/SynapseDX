// SPDX-License-Identifier: Apache-2.0
import {
  studioCodeError,
  type StudioCode,
  type WorkspaceWidget,
} from "./workspaces";
import {
  ACTION_DATA_TYPES,
  studioActionError,
  type StudioAction,
  safeActionPath,
  literalActionValue,
  transformActionValue,
} from "./studioActions";

export const STARTER_ACTION: StudioAction = {
  kind: "notify",
  message: "Action completed",
  mappings: [],
  inputs: [],
  actions: [],
  javascript:
    'async function run(input, studio) {\n  // input.widgets["form-id"].field contains page inputs.\n  // await studio.query("table-id", { limit: 20 });\n  // await studio.action("form-id", { record_id: "...", status: "done" });\n  return { message: "Action ready", input };\n}',
};
export interface ActionContext {
  event?: Record<string, unknown>;
  results?: Record<string, unknown>;
  widgets: Record<string, Record<string, unknown>>;
  selected: { resource: string; row: Record<string, unknown>; widgetId?: string } | null;
}
export function defaultActionContext(
  widgets: WorkspaceWidget[],
): ActionContext {
  return {
    selected: null,
    widgets: Object.fromEntries(
      widgets
        .filter((w) => w.type === "form")
        .map((w) => [
          w.id,
          Object.fromEntries(
            (w.fields || [])
              .filter(
                (f) => f.defaultValue !== undefined && f.defaultValue !== "",
              )
              .map((f) => {
                try {
                  return [f.name, fieldInput(f.type, f.defaultValue!)];
                } catch {
                  return [f.name, undefined];
                }
              }),
          ),
        ]),
    ),
  };
}
export function fieldInput(type: string, value: string): unknown {
  if (value === "") return undefined;
  if (type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error("Expected a finite number");
    return n;
  }
  if (type === "checkbox") return value === "true";
  // Form JSON fields deliberately stay strings: the authorized form endpoint
  // owns their JSON/business validation, just like ordinary form submission.
  return value;
}
export function resolveActionValues(
  op: StudioAction,
  context: ActionContext,
  widgets: WorkspaceWidget[],
): Record<string, unknown> {
  const path = (root: unknown, key: string): unknown => {
    if (!safeActionPath(key)) throw new Error("Unsafe field path");
    return key
      .split(".")
      .reduce<unknown>(
        (v, p) =>
          v &&
          typeof v === "object" &&
          Object.prototype.hasOwnProperty.call(v, p)
            ? (v as Record<string, unknown>)[p]
            : undefined,
        root,
      );
  };
  const values: Record<string, unknown> = {};
  for (const m of op.mappings) {
    let value: unknown;
    if (m.source === "literal") value = literalActionValue(m);
    else if (m.source === "input")
      value = path(context.widgets[m.widgetId!], m.value);
    else if (m.source === "event") value = path(context.event, m.value);
    else if (m.source === "result")
      value = path(context.results?.[m.widgetId!], m.value);
    else {
      const source = widgets.find(
        (w) => w.id === m.widgetId && ACTION_DATA_TYPES.includes(w.type),
      );
      if (source && source.resource === context.selected?.resource &&
        (!context.selected?.widgetId || context.selected.widgetId === source.id))
        value = path(context.selected?.row, m.value);
    }
    if (value === undefined || (m.source !== "literal" && value === "")) {
      if (m.required) throw new Error(`Missing input for ${m.field}`);
      continue;
    }
    values[m.field] =
      m.source === "literal" ? value : transformActionValue(value, m.transform);
  }
  return values;
}
export function compileStudioAction(
  op: StudioAction,
  context: ActionContext,
  widgets: WorkspaceWidget[],
): StudioCode {
  const error = studioActionError(op);
  if (error) throw new Error(error);
  const snapshot = JSON.stringify(context);
  if (snapshot.length > 12000)
    throw new Error(
      "Action inputs exceed 12000 characters. Use a bound query for large data.",
    );
  const functionSource =
    op.kind === "function"
      ? `${op.javascript}\nif (typeof run !== "function") throw new Error("Define async function run(input, studio)");\nconst result = await run(input, studio);`
      : ["query", "create", "update", "delete", "execute"].includes(op.kind)
        ? `const result = await studio.${op.kind === "query" ? "query" : "action"}(${JSON.stringify(op.target)}, ${JSON.stringify(resolveActionValues(op, context, widgets))});`
        : `const result = ${JSON.stringify({ preview: true, kind: op.kind, target: op.target, destination: op.destination, message: op.message, steps: op.steps, values: resolveActionValues(op, context, widgets) })};`;
  const code: StudioCode = {
    html: "<p>Running action…</p>",
    css: "body{font-size:12px;color:#64748b}",
    height: 120,
    inputs:
      op.kind === "function"
        ? op.inputs
        : op.kind === "query"
          ? [op.target!]
          : [],
    actions:
      op.kind === "function"
        ? op.actions
        : ["create", "update", "delete", "execute"].includes(op.kind)
          ? [op.target!]
          : [],
    javascript: `const input = JSON.parse(${JSON.stringify(snapshot)});\n${functionSource}\nstudio.result(result === undefined ? null : result);\nconsole.info("Action completed");\nstudio.render("<p>Action completed</p>");`,
  };
  const issue = studioCodeError(code);
  if (issue) throw new Error(issue);
  return code;
}
