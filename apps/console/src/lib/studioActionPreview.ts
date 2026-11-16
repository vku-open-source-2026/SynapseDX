// SPDX-License-Identifier: Apache-2.0
import type { StudioAction } from "./studioActions";
import { studioActionError } from "./studioActions";
import type { WorkspaceWidget, StudioCode } from "./workspaces";
import { studioCodeError } from "./workspaces";
import type { ActionContext } from "./studioActionRuntime";

type PreviewFunction = (input: ActionContext, studio: { query: (id: string, values?: Record<string, unknown>) => Promise<unknown>; action: (id: string, values?: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>;
/** Self-contained so the exact tested interpreter also runs in the isolated Studio worker. */
export async function simulateStudioAction(
  root: StudioAction, context: ActionContext, widgets: WorkspaceWidget[], fixtures: Record<string, any>,
  functions: Record<string, PreviewFunction> = {},
): Promise<{ preview: true; result: unknown; trace: { id: string; kind: string; values: Record<string, unknown>; result: unknown }[]; context: ActionContext }> {
  const state = JSON.parse(JSON.stringify(context)) as ActionContext;
  state.results ||= {};
  const trace: { id: string; kind: string; values: Record<string, unknown>; result: unknown }[] = [];
  let count = 0;
  const path = (root: unknown, key: string): unknown => {
    if (!key || key.length > 200 || key.split(".").length > 6 || key.split(".").some(p => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(p) || ["__proto__", "prototype", "constructor"].includes(p))) throw new Error("Unsafe field path");
    return key.split(".").reduce<unknown>((value, p) => value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, p) ? (value as any)[p] : undefined, root);
  };
  const transform = (value: any, mode?: string): unknown => {
    if (value === undefined || !mode) return value;
    switch (mode) {
      case "string": return String(value);
      case "number": if (!Number.isFinite(Number(value))) throw new Error("Expected a finite number"); return Number(value);
      case "boolean": if (typeof value === "boolean") return value; if (value === "true" || value === 1) return true; if (value === "false" || value === 0) return false; throw new Error("Expected true or false");
      case "json": return typeof value === "string" ? JSON.parse(value) : value;
      case "date": if (!Number.isFinite(new Date(String(value)).getTime())) throw new Error("Expected a valid date"); return new Date(String(value)).toISOString();
      case "uppercase": return String(value).toUpperCase();
      case "lowercase": return String(value).toLowerCase();
      case "trim": return String(value).trim();
    }
  };
  const query = async (id: string, values: Record<string, any> = {}) => {
    if (!Object.prototype.hasOwnProperty.call(fixtures, id)) throw new Error(`Add preview data for ${id}`);
    const fixture = fixtures[id];
    const items = Array.isArray(fixture) ? fixture : fixture.rows || fixture.items;
    if (!Array.isArray(items)) return fixture;
    let rows = [...items];
    if (values.status !== undefined) rows = rows.filter(row => String(row.status || "") === String(values.status));
    if (values.search) rows = rows.filter(row => JSON.stringify(row).toLowerCase().includes(String(values.search).toLowerCase()));
    if (values.sortBy) rows.sort((a, b) => String(a[values.sortBy] ?? "").localeCompare(String(b[values.sortBy] ?? ""), undefined, { numeric: true }) * (values.sortDirection === "desc" ? -1 : 1));
    const total = rows.length, offset = Number(values.offset || 0), limit = Number(values.limit || 50);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid preview pagination");
    rows = rows.slice(offset, offset + limit);
    return Array.isArray(fixture) ? { rows, total, offset, limit } : { ...fixture, ...(fixture.items ? { items: rows } : { rows }), total, offset, limit };
  };
  const action = async (id: string, values: Record<string, unknown> = {}) => ({ preview: true, widgetId: id, values });
  const execute = async (op: StudioAction, id: string, depth: number): Promise<unknown> => {
    if (depth > 12 || ++count > 128) throw new Error("Action preview exceeds chain limits");
    const target = widgets.find(w => w.id === op.target);
    const values: Record<string, unknown> = {};
    for (const m of op.mappings) {
      let value: unknown;
      if (m.source === "literal") { try { value = JSON.parse(m.value); } catch { value = m.value; } }
      else if (m.source === "input") value = path(state.widgets[m.widgetId!], m.value);
      else if (m.source === "event") value = path(state.event, m.value);
      else if (m.source === "result") value = path(state.results?.[m.widgetId!], m.value);
      else {
        const source = widgets.find(w => w.id === m.widgetId);
        if (source?.resource === state.selected?.resource && (!state.selected?.widgetId || source?.id === state.selected.widgetId)) value = path(state.selected?.row, m.value);
      }
      if (value === undefined || (m.source !== "literal" && value === "")) { if (m.required) throw new Error(`Missing input for ${m.field}`); continue; }
      values[m.field] = transform(value, m.transform);
    }
    const step = async (id: string) => {
      const op = widgets.find(w => w.type === "action" && w.id === id)?.operation;
      if (!op) throw new Error(`Action ${id} is unavailable`);
      return execute(op, id, depth + 1);
    };
    let result: unknown = null;
    // Record the start order and fill results when each simulated step finishes.
    const entry = { id, kind: op.kind, values, result: null as unknown }; trace.push(entry);
    switch (op.kind) {
      case "query": {
        if (target?.type === "form") {
          const field = target.fields?.find(f => f.optionsResource === op.source);
          if (!field) throw new Error("Choose a matching reference source");
          const data: any = await query(`${target.id}.${field.name}`, values);
          const items = data.items || data.rows || [];
          result = { items: items.map((row: any) => ({ value: String(row.value ?? row.id), label: String(row.label ?? row.name ?? row.title ?? row.filename ?? row.id) })), total: data.total, offset: data.offset, limit: data.limit };
        } else result = await query(op.target!, values);
        break;
      }
      case "batch": result = { batches: 1, ...(await action(op.target!, values)) }; break;
      case "create": case "update": case "delete": case "execute": result = await action(op.target!, values); break;
      case "setValues": state.widgets[op.target!] = { ...state.widgets[op.target!], ...values }; result = { updated: op.target }; break;
      case "resetForm": {
        const defaults: Record<string, unknown> = {};
        for (const field of target?.fields || []) {
          if (field.defaultValue === undefined || field.defaultValue === "") continue;
          defaults[field.name] = field.type === "number" ? Number(field.defaultValue) : field.type === "checkbox" ? field.defaultValue === "true" : field.defaultValue;
        }
        state.widgets[op.target!] = defaults; result = { updated: op.target }; break;
      }
      case "showRecord": if (!target || !state.event?.row || typeof state.event.row !== "object") throw new Error("Select a row first"); state.selected = { resource: target.resource || "", widgetId: target.id, row: state.event.row as Record<string, unknown> }; result = state.event.row; break;
      case "openForm": result = { opened: op.target }; break;
      case "refresh": result = { refreshed: op.target }; break;
      case "notify": result = { message: op.message }; break;
      case "navigate": result = { destination: op.destination }; break;
      case "export": { const data: any = await query(op.target!); result = { exported: data.rows?.length ?? data.items?.length ?? 0 }; break; }
      case "upload": result = { preview: true, id: "preview-file", filename: "preview-file", field: op.source }; break;
      case "download": result = { preview: true, downloaded: values.file_id }; break;
      case "sequence": for (const id of op.steps || []) result = await step(id); break;
      case "condition": {
        const first = Object.values(values)[0], compare = op.compareValue || "";
        const match = op.comparison === "exists" ? first !== undefined && first !== null && first !== "" : op.comparison === "equals" ? String(first) === compare : op.comparison === "notEquals" ? String(first) !== compare : op.comparison === "greater" ? Number(first) > Number(compare) : Number(first) < Number(compare);
        const branch = match ? op.then : op.otherwise;
        result = branch ? await step(branch) : null; break;
      }
      case "function": {
        if (!functions[id]) throw new Error("JavaScript preview requires the Studio sandbox");
        const studio = {
          query: async (id: string, values?: Record<string, unknown>) => { if (!op.inputs.includes(id)) throw new Error("Undeclared query binding"); return query(id, values); },
          action: async (id: string, values?: Record<string, unknown>) => { if (!op.actions.includes(id)) throw new Error("Undeclared form binding"); return action(id, values); },
        };
        result = await functions[id](state, studio); break;
      }
    }
    state.results![id] = result; entry.result = result; return result;
  };
  const result = await execute(root, "preview-root", 0);
  return { preview: true, result, trace, context: state };
}

export function compileStudioActionPreview(op: StudioAction, context: ActionContext, widgets: WorkspaceWidget[], fixtures: Record<string, unknown>): StudioCode {
  const needed = new Set<string>();
  const visit = (operation: StudioAction) => {
    const ids = [operation.target, ...operation.inputs, ...operation.actions, ...(operation.steps || []), operation.then, operation.otherwise, ...operation.mappings.map(m => m.widgetId)];
    for (const id of ids) {
      if (!id || needed.has(id)) continue; needed.add(id);
      const child = widgets.find(w => w.id === id)?.operation; if (child) visit(child);
    }
  };
  visit(op);
  widgets = widgets.filter(w => needed.has(w.id)).map(w => ({ id: w.id, type: w.type, title: "", ...(w.resource ? { resource: w.resource } : {}), ...(w.fields ? { fields: w.fields.map(f => ({ name: f.name, type: f.type, label: "", ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}), ...(f.optionsResource ? { optionsResource: f.optionsResource } : {}) })) } : {}), ...(w.operation ? { operation: w.operation } : {}) }));
  const operations = [op, ...widgets.flatMap(w => w.operation ? [w.operation] : [])];
  for (const operation of operations) { const error = studioActionError(operation); if (error) throw new Error(error); }
  const functions = [ ["preview-root", op] as const, ...widgets.filter(w => w.operation).map(w => [w.id, w.operation!] as const) ]
    .filter(([, op]) => op.kind === "function")
    .map(([id, op]) => `${JSON.stringify(id)}: async (input, studio) => { ${op.javascript}\nif(typeof run !== "function") throw new Error("Define async function run(input, studio)"); return run(input, studio); }`).join(",\n");
  const code: StudioCode = {
    html: "<p>Simulating published actions…</p>", css: "body{font-size:12px;color:#64748b}", height: 120, inputs: [], actions: [],
    javascript: `const simulate = ${simulateStudioAction.toString()};\nconst result = await simulate(${JSON.stringify(op)}, ${JSON.stringify(context)}, ${JSON.stringify(widgets)}, ${JSON.stringify(fixtures)}, {${functions}});\nstudio.result(result);\nconsole.info("Simulated " + result.trace.length + " action steps; no data was changed");\nstudio.render("<p>Preview completed</p>");`,
  };
  const error = studioCodeError(code); if (error) throw new Error(error); return code;
}
