// SPDX-License-Identifier: Apache-2.0
/** The explicit registry for declarative page behavior. Never evaluate source here. */
export const ACTION_KINDS = [
  "upload",
  "batch",
  "download",
  "query",
  "create",
  "update",
  "delete",
  "execute",
  "navigate",
  "openForm",
  "showRecord",
  "refresh",
  "resetForm",
  "setValues",
  "notify",
  "export",
  "sequence",
  "condition",
  "function",
] as const;
export const ACTION_DATA_TYPES = [
  "metric",
  "table",
  "chart",
  "list",
  "map",
  "kanban",
  "timeline",
];
export const ACTION_EVENTS = [
  "onLoad",
  "onSubmit",
  "onClick",
  "onRowClick",
  "onChange",
  "onExport",
] as const;
export const MAX_PAGE_ACTIONS = 128;
export interface ActionMapping {
  field: string;
  source: "literal" | "input" | "selected" | "event" | "result";
  value: string;
  widgetId?: string;
  required?: boolean;
  transform?:
    | "string"
    | "number"
    | "boolean"
    | "json"
    | "date"
    | "uppercase"
    | "lowercase"
    | "trim";
}
export interface StudioAction {
  kind: (typeof ACTION_KINDS)[number];
  target?: string;
  source?: string;
  mappings: ActionMapping[];
  javascript: string;
  inputs: string[];
  actions: string[];
  destination?: string;
  message?: string;
  steps?: string[];
  comparison?: "equals" | "notEquals" | "exists" | "greater" | "less";
  compareValue?: string;
  then?: string;
  otherwise?: string;
}
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const fieldPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const safeActionPath = (v: string) =>
  v.length <= 200 &&
  v.split(".").length <= 6 &&
  v.split(".").every((p) => fieldPattern.test(p) && !forbidden.has(p));
export function studioActionError(value: unknown): string | null {
  if (
    !record(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          "kind",
          "target",
          "source",
          "mappings",
          "javascript",
          "inputs",
          "actions",
          "destination",
          "message",
          "steps",
          "comparison",
          "compareValue",
          "then",
          "otherwise",
        ].includes(k),
    )
  )
    return "Invalid action settings";
  if (!(ACTION_KINDS as readonly unknown[]).includes(value.kind))
    return "Choose an action preset or JavaScript function";
  for (const key of ["target", "then", "otherwise"])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" || !idPattern.test(value[key] as string))
    )
      return "Choose a valid widget/action id";
  if (
    [
      "upload",
  "batch",
  "download",
  "query",
      "create",
      "update",
      "delete",
      "execute",
      "openForm",
      "showRecord",
      "refresh",
      "resetForm",
      "setValues",
      "export",
    ].includes(String(value.kind)) &&
    !value.target
  )
    return "Choose a target widget";
  if (
    value.source !== undefined &&
    (typeof value.source !== "string" ||
      !(["upload", "batch"].includes(String(value.kind)) ? fieldPattern.test(value.source) && !forbidden.has(value.source) : /^[a-z][a-zA-Z0-9-]{0,79}$/.test(value.source)))
  )
    return "Choose a catalog source";
  if (
    value.destination !== undefined &&
    (typeof value.destination !== "string" ||
      !/^(page|section|module):[a-z][a-z0-9-]{0,63}$/.test(value.destination))
  )
    return "Choose a workspace navigation destination";
  if (value.kind === "navigate" && !value.destination)
    return "Choose a workspace navigation destination";
  for (const key of ["message", "compareValue"])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" ||
        (value[key] as string).length > 1000 ||
        (value[key] as string).includes("\0"))
    )
      return "Action text supports up to 1000 characters";
  if (
    typeof value.javascript !== "string" ||
    value.javascript.length > 16000 ||
    value.javascript.includes("\0")
  )
    return "Function source supports up to 16000 characters";
  for (const key of ["inputs", "actions"]) {
    const ids = value[key];
    if (
      !Array.isArray(ids) ||
      ids.length > 20 ||
      ids.some((id) => typeof id !== "string" || !idPattern.test(id)) ||
      new Set(ids).size !== ids.length
    )
      return "Choose up to 20 unique widget bindings";
  }
  if (
    value.steps !== undefined &&
    (!Array.isArray(value.steps) ||
      value.steps.length > 20 ||
      value.steps.some((id) => typeof id !== "string" || !idPattern.test(id)))
  )
    return "Choose up to 20 action steps";
  if (
    value.kind === "sequence" &&
    (!Array.isArray(value.steps) || !value.steps.length)
  )
    return "Choose at least one action step";
  if (
    value.kind === "condition" &&
    (!["equals", "notEquals", "exists", "greater", "less"].includes(
      String(value.comparison),
    ) ||
      !value.then)
  )
    return "Choose a comparison and a matching action";
  if (!Array.isArray(value.mappings) || value.mappings.length > 30)
    return "Choose up to 30 input mappings";
  const fields = new Set();
  for (const m of value.mappings) {
    if (
      !record(m) ||
      Object.keys(m).some(
        (k) =>
          ![
            "field",
            "source",
            "value",
            "widgetId",
            "required",
            "transform",
          ].includes(k),
      )
    )
      return "Invalid input mapping";
    if (
      typeof m.field !== "string" ||
      !fieldPattern.test(m.field) ||
      forbidden.has(m.field) ||
      fields.has(m.field)
    )
      return "Mapping fields must be unique field names";
    fields.add(m.field);
    if (
      !["literal", "input", "selected", "event", "result"].includes(
        String(m.source),
      ) ||
      typeof m.value !== "string" ||
      m.value.length > 4000 ||
      m.value.includes("\0")
    )
      return "Invalid mapping value";
    if (m.source !== "literal" && !safeActionPath(m.value))
      return "Choose a safe field path";
    if (
      ["input", "selected", "result"].includes(String(m.source)) &&
      (typeof m.widgetId !== "string" || !idPattern.test(m.widgetId))
    )
      return "Choose an input widget or action";
    if (
      m.widgetId !== undefined &&
      (typeof m.widgetId !== "string" || !idPattern.test(m.widgetId))
    )
      return "Invalid mapping widget";
    if (m.required !== undefined && typeof m.required !== "boolean")
      return "Invalid required mapping setting";
    if (
      m.transform !== undefined &&
      ![
        "string",
        "number",
        "boolean",
        "json",
        "date",
        "uppercase",
        "lowercase",
        "trim",
      ].includes(String(m.transform))
    )
      return "Choose a supported transform";
  }
  return null;
}
export interface ActionWidget {
  id: string;
  type: string;
  title?: string;
  action?: string;
  resource?: string;
  fields?: {
    name: string;
    required?: boolean;
    optionsResource?: string;
    optionsAction?: string;
    type?: string;
    uploadAction?: string;
  }[];
  onClick?: string;
  onLoad?: string;
  onSubmit?: string;
  onRowClick?: string;
  onChange?: string;
  onExport?: string;
  links?: { label: string; target: string; actionId?: string }[];
  updateForm?: string;
  operation?: StudioAction;
  code?: { inputs: string[]; actions: string[] };
}
export const MAX_ACTION_EXECUTIONS = 128;
export function actionReferenceErrors(widgets: ActionWidget[]): string[] {
  const errors: string[] = [];
  const actions = widgets.filter((w) => w.type === "action");
  const get = (id?: string) => actions.find((w) => w.id === id);
  for (const w of widgets) {
    for (const key of ACTION_EVENTS)
      if (w[key] && !get(w[key]))
        errors.push(`${w.id}.${key} must reference an action in this page`);
    for (const link of w.links || [])
      if (link.actionId && !get(link.actionId))
        errors.push(`Navigation ${w.id} must reference an action in this page`);
    if (w.onLoad) {
      const op = get(w.onLoad)?.operation;
      if (
        op &&
        !(
          (op.kind === "query" && op.target === w.id) ||
          (op.kind === "function" &&
            op.inputs.includes(w.id) &&
            !op.actions.length)
        )
      )
        errors.push(
          `${w.id}.onLoad must use its query or a read-only function with a declared source`,
        );
    }
    if (w.onSubmit) {
      const op = get(w.onSubmit)?.operation;
      if (op && ((op.kind !== w.action && !(op.kind === "batch" && w.action === "execute")) || op.target !== w.id))
        errors.push(`${w.id}.onSubmit must use its matching form action`);
    }
    for (const [event, kind] of [
      ["onRowClick", "showRecord"],
      ["onExport", "export"],
    ] as const)
      if (w[event]) {
        const op = get(w[event])?.operation;
        if (op && (op.kind !== kind || op.target !== w.id))
          errors.push(`${w.id}.${event} must use its ${kind} action`);
      }
    if (w.onChange) {
      const op = get(w.onChange)?.operation;
      if (op && (op.kind !== "update" || op.target !== w.updateForm))
        errors.push(`${w.id}.onChange must use its board update action`);
    }
    for (const link of w.links || [])
      if (link.actionId) {
        const op = get(link.actionId)?.operation;
        if (op && (op.kind !== "navigate" || op.destination !== link.target))
          errors.push(`${w.id}: navigation target must match its action`);
      }
    for (const f of w.fields || []) {
      if (f.type === "file" && !f.uploadAction)
        errors.push(`${w.id}.${f.name}: choose a published upload action`);
      if (f.uploadAction) {
        const upload = get(f.uploadAction)?.operation;
        if (f.type !== "file" || upload?.kind !== "upload" || upload.target !== w.id || upload.source !== f.name)
          errors.push(`${w.id}.${f.name}: upload action must match its file field`);
      }
    }
    for (const f of w.fields || [])
      if (f.optionsAction) {
        const op = get(f.optionsAction)?.operation;
        if (
          !op ||
          op.kind !== "query" ||
          op.target !== w.id ||
          op.source !== f.optionsResource
        )
          errors.push(`${w.id}.${f.name}: choose a matching reference query`);
      }
    const op = w.operation;
    if (!op || studioActionError(op)) continue;
    const target = widgets.find((t) => t.id === op.target);
    const targetTypes: Record<string, string[]> = {
      upload: ["form"],
      batch: ["form"],
      download: ACTION_DATA_TYPES,
      query: [...ACTION_DATA_TYPES, "form"],
      create: ["form"],
      update: ["form"],
      delete: ["form"],
      execute: ["form"],
      openForm: ["form"],
      showRecord: ACTION_DATA_TYPES,
      refresh: ACTION_DATA_TYPES,
      resetForm: ["form"],
      setValues: ["form"],
      export: ACTION_DATA_TYPES,
    };
    if (
      targetTypes[op.kind] &&
      (!target ||
        !targetTypes[op.kind].includes(target.type) ||
        (["create", "update", "delete", "execute"].includes(op.kind) &&
          (target.action || "create") !== op.kind))
    )
      errors.push(
        `Action ${w.id} needs a matching ${op.kind} target in this page`,
      );
    if (op.kind === "batch" && (target?.action !== "execute" || !target.fields?.some(f => f.name === op.source && f.type === "number") || !op.mappings.some(m => m.field === op.source && m.source !== "literal")))
      errors.push(`Batch ${w.id} needs an execute form and a mapped numeric offset field`);
    if (op.kind === "upload" && !target?.fields?.some(f => f.name === op.source && f.type === "file"))
      errors.push(`Upload ${w.id} must target a declared file field`);
    if (op.kind === "upload" && op.mappings.length)
      errors.push(`Upload ${w.id} takes bytes from its file field, without mappings`);
    if (op.kind === "download" && (op.mappings.length !== 1 || op.mappings[0].field !== "file_id"))
      errors.push(`Download ${w.id} requires exactly one file_id mapping`);
    if (
      op.kind === "query" &&
      !(
        (target?.type !== "form" && op.source === target?.resource) ||
        target?.fields?.some((f) => f.optionsResource === op.source)
      )
    )
      errors.push(`Query ${w.id} must declare the target catalog source`);
    for (const [key, types] of [
      ["inputs", ACTION_DATA_TYPES],
      ["actions", ["form"]],
    ] as const)
      for (const id of op[key])
        if (
          !widgets.some(
            (t) => t.id === id && (types as readonly string[]).includes(t.type),
          )
        )
          errors.push(
            `Action binding ${id} must reference a matching widget in this page`,
          );
    for (const id of [
      ...(op.steps || []),
      ...(op.then ? [op.then] : []),
      ...(op.otherwise ? [op.otherwise] : []),
    ])
      if (!get(id))
        errors.push(`Action step ${id} must reference an action in this page`);
    for (const m of op.mappings) {
      if (op.kind === "function") {
        errors.push(
          "Function actions use input and declared bindings, not preset mappings",
        );
        break;
      }
      if (
        op.kind === "query" &&
        ![
          "limit",
          "offset",
          "search",
          "status",
          "sortBy",
          "sortDirection",
        ].includes(m.field)
      )
        errors.push(
          "Query mappings support pagination, search, status and sorting",
        );
      if (
        ["create", "update", "delete", "execute", "batch", "setValues"].includes(
          op.kind,
        ) &&
        target &&
        !target.fields?.some((f) => f.name === m.field)
      )
        errors.push(`Mapping ${m.field} must match a target form field`);
      if (
        m.source === "input" &&
        !widgets.some(
          (t) =>
            t.id === m.widgetId &&
            t.type === "form" &&
            t.fields?.some((f) => f.name === m.value),
        )
      )
        errors.push(
          `Mapping ${m.field} needs a matching input field in this page`,
        );
      if (
        m.source === "selected" &&
        !widgets.some(
          (t) => t.id === m.widgetId && ACTION_DATA_TYPES.includes(t.type),
        )
      )
        errors.push(`Mapping ${m.field} needs a data widget in this page`);
      if (m.source === "result" && !get(m.widgetId))
        errors.push(`Mapping ${m.field} needs an action result in this page`);
    }
  }
  // Memoize subtree height/cost, not visited nodes: a shared suffix can be
  // reached from a deeper root or repeated many times in an ordered sequence.
  const visiting = new Set<string>();
  const memo = new Map<string, { height: number; cost: number }>();
  const measure = (id: string): { height: number; cost: number } => {
    if (visiting.has(id)) {
      errors.push("Action chains must be acyclic and at most 12 steps deep");
      return { height: 13, cost: MAX_ACTION_EXECUTIONS + 1 };
    }
    const cached = memo.get(id);
    if (cached) return cached;
    visiting.add(id);
    const op = get(id)?.operation;
    const children = op?.kind === "sequence" ? op.steps || []
      : op?.kind === "condition" ? [op.then, op.otherwise].filter((v): v is string => !!v) : [];
    const sizes = children.map(measure);
    const size = {
      height: sizes.length ? 1 + Math.max(...sizes.map(s => s.height)) : 0,
      cost: Math.min(MAX_ACTION_EXECUTIONS + 1, 1 + (op?.kind === "condition"
        ? Math.max(0, ...sizes.map(s => s.cost))
        : sizes.reduce((sum, s) => sum + s.cost, 0))),
    };
    visiting.delete(id);
    memo.set(id, size);
    return size;
  };
  for (const a of actions) {
    const size = measure(a.id);
    if (size.height > 12) errors.push("Action chains must be acyclic and at most 12 steps deep");
    if (size.cost > MAX_ACTION_EXECUTIONS) errors.push(`Action chains may execute at most ${MAX_ACTION_EXECUTIONS} actions`);
  }
  return errors;
}
export function actionGovernanceErrors(widgets: ActionWidget[]): string[] {
  const errors = actionReferenceErrors(widgets);
  for (const w of widgets) {
    if (w.type === "button" && !w.onClick && !w.links?.length)
      errors.push(`${w.title || w.id}: assign a click action`);
    if (ACTION_DATA_TYPES.includes(w.type) && !w.onLoad)
      errors.push(`${w.title || w.id}: assign a read action before publishing`);
    if (w.type === "form" && !w.onSubmit)
      errors.push(
        `${w.title || w.id}: assign a submit action before publishing`,
      );
    if (w.updateForm && !w.onChange)
      errors.push(
        `${w.title || w.id}: assign a card-change action before publishing`,
      );
    if (
      ["navigation", "tabs"].includes(w.type) ||
      (w.type === "button" && !w.onClick)
    )
      for (const link of w.links || [])
        if (!link.actionId)
          errors.push(
            `${w.title || w.id}: assign a navigation action for ${link.label}`,
          );
    for (const f of w.fields || [])
      if (f.optionsResource && !f.optionsAction)
        errors.push(`${w.title || w.id}.${f.name}: assign a reference query`);
    if (w.type === "capability")
      errors.push(
        `${w.title || w.id}: replace the legacy module with declarative components or an explicit code widget`,
      );
  }
  return errors;
}
/** Check an immutable published registry before exposing a technical binding. */
export function registeredBinding(
  widgets: ActionWidget[],
  actionId: unknown,
  target: string,
  kind: "query" | "mutation" | "upload" | "download",
): StudioAction | null {
  const op = widgets.find(
    (w) => w.type === "action" && w.id === actionId,
  )?.operation;
  if (
    op &&
    (op.kind === "function"
      ? ["query", "mutation"].includes(kind) && (kind === "query" ? op.inputs : op.actions).includes(target)
      : op.target === target &&
        (kind === "upload" || kind === "download" ? op.kind === kind : kind === "query"
          ? op.kind === "query"
          : ["create", "update", "delete", "execute", "batch"].includes(op.kind)))
  )
    return op;
  if (
    ["query", "mutation"].includes(kind) &&
    typeof actionId === "string" &&
    actionId.startsWith("code:") &&
    widgets.some(
      (w) =>
        w.id === actionId.slice(5) &&
        w.type === "code" &&
        (kind === "query" ? w.code?.inputs : w.code?.actions)?.includes(target),
    )
  )
    return {
      kind: "function",
      mappings: [],
      javascript: "",
      inputs: [],
      actions: [],
    };
  return null;
}

/** Shared value resolution used by browser presets and server static-value enforcement. */
export function transformActionValue(
  value: unknown,
  transform?: ActionMapping["transform"],
): unknown {
  if (value === undefined || !transform) return value;
  switch (transform) {
    case "string":
      return String(value);
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error("Expected a finite number");
      return n;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === 1) return true;
      if (value === "false" || value === 0) return false;
      throw new Error("Expected true or false");
    case "json":
      return typeof value === "string" ? JSON.parse(value) : value;
    case "date": {
      const date = new Date(String(value));
      if (!Number.isFinite(date.getTime()))
        throw new Error("Expected a valid date");
      return date.toISOString();
    }
    case "uppercase":
      return String(value).toUpperCase();
    case "lowercase":
      return String(value).toLowerCase();
    case "trim":
      return String(value).trim();
  }
}
export function literalActionValue(mapping: ActionMapping): unknown {
  let value: unknown = mapping.value;
  try {
    value = JSON.parse(mapping.value);
  } catch {
    /* plain string */
  }
  return transformActionValue(value, mapping.transform);
}
/** Reject extra inputs and any change to values fixed by the published action. */
export function actionPayloadError(
  op: StudioAction,
  values: unknown,
): string | null {
  if (!record(values)) return "Expected an object of action values";
  if (op.kind === "function") return null;
  for (const key of Object.keys(values))
    if (!op.mappings.some((m) => m.field === key))
      return `Field ${key} is not declared by this action`;
  for (const m of op.mappings) {
    if (m.required && (values[m.field] === undefined || values[m.field] === ""))
      return `Missing action input ${m.field}`;
    if (
      m.source === "literal" &&
      JSON.stringify(values[m.field]) !== JSON.stringify(literalActionValue(m))
    )
      return `Fixed action value ${m.field} cannot be overridden`;
  }
  return null;
}
/** Explicit, persisted conversion for legacy layouts. Never called by runtime. */
export function materializeActions<T extends ActionWidget>(original: T[]): T[] {
  const widgets = structuredClone(original),
    added: T[] = [];
  const add = (widget: T, event: string, op: StudioAction, title: string) => {
    const prefix = `act-${widget.id.slice(0, 42)}-${event}`.slice(0, 61);
    let id = prefix,
      n = 1;
    while ([...widgets, ...added].some((w) => w.id === id))
      id = `${prefix.slice(0, 58)}-${n++}`;
    added.push({ id, type: "action", title, operation: op } as T);
    return id;
  };
  const operation = (
    kind: StudioAction["kind"],
    target?: string,
  ): StudioAction => ({
    kind,
    ...(target ? { target } : {}),
    mappings: [],
    javascript: "",
    inputs: [],
    actions: [],
  });
  for (const w of widgets) {
    if (ACTION_DATA_TYPES.includes(w.type)) {
      if (!w.onLoad)
        w.onLoad = add(
          w,
          "load",
          {
            ...operation("query", w.id),
            source: w.resource,
            mappings: ["limit", "offset", "search"].map((field) => ({
              field,
              source: "event",
              value: field,
            })),
          },
          `Read ${w.title || w.id}`,
        );
      if (w.type !== "metric" && w.type !== "chart" && !w.onRowClick)
        w.onRowClick = add(
          w,
          "row",
          operation("showRecord", w.id),
          `Inspect ${w.title || w.id}`,
        );
      if (w.type !== "metric" && w.type !== "chart" && !w.onExport)
        w.onExport = add(
          w,
          "export",
          operation("export", w.id),
          `Export ${w.title || w.id}`,
        );
    }
    if (w.type === "form") {
      for (const f of w.fields || [])
        if (f.type === "file" && !f.uploadAction)
          f.uploadAction = add(w, `upload-${f.name.replaceAll("_", "-").slice(0, 12)}`, { ...operation("upload", w.id), source: f.name }, `Upload ${w.title || w.id} · ${f.name}`);
      for (const f of w.fields || [])
        if (f.optionsResource && !f.optionsAction)
          f.optionsAction = add(
            w,
            `opt-${f.name.replaceAll("_", "-").toLowerCase().slice(0, 12)}`,
            { ...operation("query", w.id), source: f.optionsResource },
            `Options ${w.title || w.id} · ${f.name}`,
          );
      if (!w.onSubmit)
        w.onSubmit = add(
          w,
          "submit",
          {
            ...operation((w.action || "create") as StudioAction["kind"], w.id),
            mappings: (w.fields || []).map((f) => ({
              field: f.name,
              source: "event",
              value: `values.${f.name}`,
              required: !!f.required,
            })),
          },
          `Submit ${w.title || w.id}`,
        );
      if (
        ![...widgets, ...added].some(
          (a) =>
            a.operation?.kind === "openForm" && a.operation.target === w.id,
        )
      )
        add(w, "open", operation("openForm", w.id), `Open ${w.title || w.id}`);
    }
    if (w.updateForm && !w.onChange)
      w.onChange = add(
        w,
        "change",
        {
          ...operation("update", w.updateForm),
          mappings: [
            {
              field: "record_id",
              source: "event",
              value: "row.id",
              required: true,
            },
            {
              field:
                (w as T & { groupBy?: string; columns?: string[] }).groupBy ||
                (w as T & { columns?: string[] }).columns?.[1] ||
                "status",
              source: "event",
              value: "value",
              required: true,
            },
          ],
        },
        `Move ${w.title || w.id}`,
      );
    for (const [i, link] of (w.links || []).entries())
      if (!link.actionId)
        link.actionId = add(
          w,
          `link${i + 1}`,
          { ...operation("navigate"), destination: link.target },
          `Navigate ${link.label}`,
        );
  }
  // Old explicit query actions gain an auditable source declaration.
  for (const w of widgets)
    if (w.operation?.kind === "query" && !w.operation.source)
      w.operation.source = widgets.find(
        (t) => t.id === w.operation?.target,
      )?.resource;
  return [...widgets, ...added];
}
export function actionUsages(widgets: ActionWidget[], id: string): string[] {
  return widgets.flatMap((w) => [
    ...(w.fields || []).filter(f => f.uploadAction === id).map(f => `${w.title || w.id} · ${f.name} upload`),
    ...ACTION_EVENTS.filter((e) => w[e] === id).map(
      (e) => `${w.title || w.id} · ${e}`,
    ),
    ...(w.links || [])
      .filter((l) => l.actionId === id)
      .map((l) => `${w.title || w.id} · ${l.label}`),
    ...((w.operation?.steps || []).includes(id) ||
    w.operation?.then === id ||
    w.operation?.otherwise === id
      ? [`${w.title || w.id} · chain`]
      : []),
  ]);
}
