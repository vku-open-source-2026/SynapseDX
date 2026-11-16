// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense, useState } from "react";
import { Code2, Play, Plus, Square, Trash2, Zap } from "lucide-react";
import { Modal, ModalError } from "../../../components/Modal";
import {
  Button,
  Field,
  inputClassName,
  selectClassName,
} from "../../../components/ui";
import {
  CodeWidget,
  type StudioLog,
} from "../../../components/workspaces/CodeWidget";
import {
  ACTION_KINDS,
  actionUsages,
  ACTION_DATA_TYPES,
  studioActionError,
  type ActionMapping,
  type StudioAction,
} from "../../../lib/studioActions";
import {
  defaultActionContext,
  STARTER_ACTION,
  type ActionContext,
} from "../../../lib/studioActionRuntime";
import { compileStudioActionPreview } from "../../../lib/studioActionPreview";
import type { StudioCode, WorkspaceWidget } from "../../../lib/workspaces";
const CodeEditor = lazy(() =>
  import("../../../components/workspaces/CodeEditor").then((m) => ({
    default: m.CodeEditor,
  })),
);
const LABELS = {
  batch: "Run paginated workflow",
  upload: "Upload file",
  download: "Download file / artifact",
  query: "Read data",
  create: "Create record",
  update: "Update record",
  delete: "Delete record",
  execute: "Execute workflow",
  function: "JavaScript function / query",
  navigate: "Navigate to page / section",
  openForm: "Open form",
  showRecord: "Inspect record",
  refresh: "Refresh query",
  resetForm: "Reset form",
  setValues: "Set form inputs",
  notify: "Show message",
  export: "Export current data",
  sequence: "Run action sequence",
  condition: "Conditional branch",
};
export function ActionEditor({
  widget,
  widgets,
  onChange,
}: {
  widget: WorkspaceWidget;
  widgets: WorkspaceWidget[];
  onChange: (patch: Partial<WorkspaceWidget>) => void;
}) {
  const op = widget.operation || STARTER_ACTION;
  const patch = (change: Partial<StudioAction>) => {
    setRun(null);
    onChange({ operation: { ...op, ...change } });
  };
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"function" | "input" | "fixtures">("function");
  const [context, setContext] = useState(() =>
    JSON.stringify(defaultActionContext(widgets), null, 2),
  );
  const [fixtures, setFixtures] = useState(() =>
    JSON.stringify(
      Object.fromEntries([
        ...widgets
          .filter((w) => ACTION_DATA_TYPES.includes(w.type))
          .map((w) => [w.id, { rows: [], total: 0 }]),
        ...widgets.flatMap(w => (w.fields || []).filter(f => f.optionsResource).map(f => [`${w.id}.${f.name}`, { items: [], total: 0 }])),
      ]),
      null,
      2,
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<{
    id: number;
    code: StudioCode;
    data: Record<string, unknown>;
  } | null>(null);
  const [result, setResult] = useState<{ value: unknown } | null>(null);
  const [logs, setLogs] = useState<StudioLog[]>([]);
  const candidates = (kind: StudioAction["kind"]) =>
    widgets.filter((w) =>
      ["query", "showRecord", "refresh", "export", "download"].includes(kind)
        ? ACTION_DATA_TYPES.includes(w.type) ||
          (kind === "query" &&
            w.type === "form" &&
            w.fields?.some((f) => f.optionsResource))
        : ["openForm", "resetForm", "setValues", "upload"].includes(kind)
          ? w.type === "form"
          : w.type === "form" && (w.action === kind || (kind === "batch" && w.action === "execute")),
    );
  const target = widgets.find((w) => w.id === op.target);
  const useTarget = (kind: StudioAction["kind"], id?: string) => {
    setTab(kind === "function" ? "function" : "input");
    const w = widgets.find((w) => w.id === id);
    patch({
      kind,
      target: id,
      source: kind === "batch" ? w?.fields?.find(f => f.type === "number")?.name : kind === "upload" ? w?.fields?.find(f => f.type === "file")?.name : kind === "query" ? (w?.type === "form" ? w.fields?.find(f => f.optionsResource)?.optionsResource : w?.resource) : undefined,
      destination: kind === "navigate" ? "section:tasks" : undefined,
      steps: kind === "sequence" ? [] : undefined,
      comparison: kind === "condition" ? "exists" : undefined,
      then: undefined,
      otherwise: undefined,
      mappings: ["create", "update", "delete", "execute", "batch", "setValues"].includes(
        kind,
      )
        ? (w?.fields || []).map((f) => ({
            field: f.name,
            source: "event",
            value: `values.${f.name}`,
            required: !!f.required,
          }))
        : kind === "query" && w?.type !== "form"
          ? [
              "limit",
              "offset",
              "search",
              "status",
              "sortBy",
              "sortDirection",
            ].map((field) => ({
              field,
              source: "event",
              value: field,
            }))
          : [],
      inputs: [],
      actions: [],
    });
  };
  const fields =
    op.kind === "query"
      ? ["limit", "offset", "search", "status", "sortBy", "sortDirection"]
      : op.kind === "download" ? ["file_id"] : op.kind === "condition"
        ? ["value"]
        : (target?.fields || []).map((f) => f.name);
  const updateMapping = (index: number, change: Partial<ActionMapping>) =>
    patch({
      mappings: op.mappings.map((m, i) =>
        i === index ? { ...m, ...change } : m,
      ),
    });
  const launch = () => {
    setError(null);
    setResult(null);
    setLogs([]);
    setRun(null);
    try {
      const input = JSON.parse(context) as ActionContext;
      if (
        !input ||
        typeof input !== "object" ||
        !input.widgets ||
        typeof input.widgets !== "object" ||
        Array.isArray(input.widgets) ||
        !(
          input.selected === null ||
          (input.selected &&
            typeof input.selected === "object" &&
            input.selected.row &&
            typeof input.selected.resource === "string")
        )
      )
        throw new Error(
          "Preview input requires { widgets: { formId: { field: value } }, selected: null | { resource, row } }",
        );
      const data = JSON.parse(fixtures);
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error(
          "Query fixtures must be an object keyed by data widget id",
        );
      setRun({
        id: Date.now(),
        code: compileStudioActionPreview(op, input, widgets, data),
        data,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const actionList = widgets.filter(
    (w) => w.type === "action" && w.id !== widget.id,
  );
  const actionSelect = (
    value: string | undefined,
    onSelect: (value: string) => void,
    label: string,
  ) => (
    <Field label={label}>
      <select
        className={selectClassName}
        value={value || ""}
        onChange={(e) => onSelect(e.target.value)}
      >
        <option value="">Choose action</option>
        {actionList.map((w) => (
          <option key={w.id} value={w.id}>
            {w.title} · {w.operation?.kind}
          </option>
        ))}
      </select>
    </Field>
  );
  const settings = (
    <div className="space-y-4">
      <Field label="Action preset">
        <select
          aria-label="Action preset"
          className={selectClassName}
          value={op.kind}
          onChange={(e) => {
            const kind = e.target.value as StudioAction["kind"];
            useTarget(kind, candidates(kind)[0]?.id);
          }}
        >
          {ACTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {LABELS[k]}
            </option>
          ))}
        </select>
      </Field>
      {candidates(op.kind).length > 0 ||
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
      ].includes(op.kind) ? (
        <Field
          label={op.kind === "query" ? "Read from" : "Target binding"}
          help="The server verifies the published source, product and membership on every call."
        >
          <select
            aria-label="Action target"
            className={selectClassName}
            value={op.target || ""}
            onChange={(e) => useTarget(op.kind, e.target.value || undefined)}
          >
            <option value="">Choose a binding</option>
            {candidates(op.kind).map((w) => (
              <option key={w.id} value={w.id}>
                {w.title} · {w.resource}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {op.kind === "batch" && target && <Field label="Pagination offset field" help="The workflow returns nextOffset while more rows remain. Every batch uses this published form and workflow."><select aria-label="Batch offset field" className={selectClassName} value={op.source || ""} onChange={e => patch({ source: e.target.value })}><option value="">Choose offset field</option>{target.fields?.filter(f => f.type === "number").map(f => <option key={f.name} value={f.name}>{f.label}</option>)}</select></Field>}
      {op.kind === "upload" && target && <Field label="File field"><select aria-label="Upload field" className={selectClassName} value={op.source || ""} onChange={e => patch({ source: e.target.value })}><option value="">Choose file field</option>{target.fields?.filter(f => f.type === "file").map(f => <option key={f.name} value={f.name}>{f.label}</option>)}</select></Field>}
      {op.kind === "query" && target && (
        <Field label="Authorized catalog source">
          <select
            aria-label="Query source"
            className={selectClassName}
            value={op.source || ""}
            onChange={(e) => patch({ source: e.target.value })}
          >
            <option value="">Choose source</option>
            {[
              ...new Set([
                ...(target.type !== "form" && target.resource
                  ? [target.resource]
                  : []),
                ...(target.fields || []).flatMap((f) =>
                  f.optionsResource ? [f.optionsResource] : [],
                ),
              ]),
            ].map((source) => (
              <option key={source}>{source}</option>
            ))}
          </select>
          <p className="mt-2 text-xs text-dx-muted">
            Source → {target.resource} → {target.title}. To transform query
            results, choose a read-only JavaScript function and declare its
            readable sources.
          </p>
        </Field>
      )}
      {target?.workflowArtifactId && (
        <a
          className="text-xs text-indigo-600 underline"
          href={`/admin/workflows?artifact=${encodeURIComponent(target.workflowArtifactId)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Edit server workflow
        </a>
      )}
      {op.kind === "navigate" && (
        <Field label="Workspace destination">
          <input
            aria-label="Navigation destination"
            className={inputClassName}
            value={op.destination || ""}
            placeholder="page:assets or section:tasks"
            onChange={(e) => patch({ destination: e.target.value })}
          />
        </Field>
      )}
      {op.kind === "notify" && (
        <Field label="Message">
          <textarea
            className={inputClassName}
            value={op.message || ""}
            maxLength={1000}
            onChange={(e) => patch({ message: e.target.value })}
          />
        </Field>
      )}
      {op.kind === "sequence" && (
        <div className="space-y-2">
          <p className="text-xs font-semibold">
            Ordered steps · each step uses its own published action
          </p>
          {(op.steps || []).map((id, i) => (
            <div key={i} className="flex gap-2">
              {actionSelect(
                id,
                (value) =>
                  patch({
                    steps: op.steps?.map((step, j) => (i === j ? value : step)),
                  }),
                `Step ${i + 1}`,
              )}
              <Button
                onClick={() =>
                  patch({ steps: op.steps?.filter((_, j) => i !== j) })
                }
              >
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
          <Button
            disabled={(op.steps?.length || 0) >= 20 || !actionList.length}
            onClick={() =>
              patch({ steps: [...(op.steps || []), actionList[0].id] })
            }
          >
            <Plus size={13} />
            Add step
          </Button>
        </div>
      )}
      {op.kind === "condition" && (
        <>
          <Field label="Comparison">
            <select
              className={selectClassName}
              value={op.comparison || "exists"}
              onChange={(e) =>
                patch({
                  comparison: e.target.value as StudioAction["comparison"],
                })
              }
            >
              {["exists", "equals", "notEquals", "greater", "less"].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
          <Field label="Compare with">
            <input
              className={inputClassName}
              value={op.compareValue || ""}
              onChange={(e) => patch({ compareValue: e.target.value })}
            />
          </Field>
          {actionSelect(op.then, (value) => patch({ then: value }), "If true")}
          {actionSelect(
            op.otherwise,
            (value) => patch({ otherwise: value || undefined }),
            "Otherwise (optional)",
          )}
        </>
      )}
      {fields.length > 0 &&
        [
          "query",
          "create",
          "update",
          "delete",
          "execute",
          "setValues",
          "condition",
        ].includes(op.kind) && (
          <div className="space-y-3">
            <p className="text-xs font-semibold">Input mapping</p>
            {op.mappings.map((m, i) => (
              <div
                key={i}
                aria-label={`Mapping ${i + 1}`}
                className="space-y-2 rounded-xl border border-dx-line bg-dx-subtle/50 p-3"
              >
                <div className="flex gap-2">
                  <select
                    aria-label={`Target field ${i + 1}`}
                    className={selectClassName}
                    value={m.field}
                    onChange={(e) =>
                      updateMapping(i, { field: e.target.value })
                    }
                  >
                    <option value="">Target field</option>
                    {fields
                      .filter(
                        (f) =>
                          f === m.field ||
                          !op.mappings.some((x) => x.field === f),
                      )
                      .map((f) => (
                        <option key={f}>{f}</option>
                      ))}
                  </select>
                  <Button
                    aria-label={`Remove mapping ${i + 1}`}
                    onClick={() =>
                      patch({ mappings: op.mappings.filter((_, j) => j !== i) })
                    }
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
                <select
                  aria-label={`Input source ${i + 1}`}
                  className={selectClassName}
                  value={
                    m.source === "literal" || m.source === "event"
                      ? m.source
                      : `${m.source}:${m.widgetId}`
                  }
                  onChange={(e) => {
                    const [source, id] = e.target.value.split(":");
                    updateMapping(i, {
                      source: source as ActionMapping["source"],
                      widgetId: id,
                      value:
                        source === "event"
                          ? "values." + m.field
                          : source === "selected"
                            ? "id"
                            : source === "input"
                              ? widgets.find((w) => w.id === id)?.fields?.[0]
                                  ?.name || ""
                              : "",
                    });
                  }}
                >
                  <option value="literal">Static value / JSON</option>
                  <option value="event">
                    Event input (values.field, row.id, value, search)
                  </option>
                  <optgroup label="Form inputs">
                    {widgets
                      .filter((w) => w.type === "form")
                      .map((w) => (
                        <option key={w.id} value={`input:${w.id}`}>
                          {w.title}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="Selected record">
                    {widgets
                      .filter((w) => ACTION_DATA_TYPES.includes(w.type))
                      .map((w) => (
                        <option key={w.id} value={`selected:${w.id}`}>
                          {w.title}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="Previous action result">
                    {actionList.map((w) => (
                      <option key={w.id} value={`result:${w.id}`}>
                        {w.title}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <input
                  aria-label={`Mapping value ${i + 1}`}
                  className={inputClassName}
                  value={m.value}
                  maxLength={m.source === "literal" ? 4000 : 200}
                  placeholder={
                    m.source === "literal"
                      ? "Static text or JSON"
                      : "Field path, e.g. values.status or row.id"
                  }
                  onChange={(e) => updateMapping(i, { value: e.target.value })}
                />
                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Transform ${i + 1}`}
                    className={selectClassName}
                    value={m.transform || ""}
                    onChange={(e) =>
                      updateMapping(i, {
                        transform: (e.target.value ||
                          undefined) as ActionMapping["transform"],
                      })
                    }
                  >
                    <option value="">Keep original type</option>
                    {[
                      "string",
                      "number",
                      "boolean",
                      "json",
                      "date",
                      "trim",
                      "uppercase",
                      "lowercase",
                    ].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={!!m.required}
                      onChange={(e) =>
                        updateMapping(i, { required: e.target.checked })
                      }
                    />
                    Required
                  </label>
                </div>
              </div>
            ))}
            <Button
              disabled={fields.every((f) =>
                op.mappings.some((m) => m.field === f),
              )}
              onClick={() =>
                patch({
                  mappings: [
                    ...op.mappings,
                    {
                      field:
                        fields.find(
                          (f) => !op.mappings.some((m) => m.field === f),
                        ) || "",
                      source: "literal",
                      value: "",
                    },
                  ],
                })
              }
            >
              <Plus size={13} />
              Add mapping
            </Button>
          </div>
        )}
      {op.kind === "function" && (
        <div className="space-y-3">
          <p className="text-xs leading-5 text-dx-muted">
            Define <code>async function run(input, studio)</code>. Use{" "}
            <code>input.event</code>, <code>input.widgets</code>,{" "}
            <code>input.selected</code>, and <code>input.results</code>. A query
            function must return <code>{"{rows, total, columns}"}</code>.
            Network access is limited to the declared sources below.
          </p>
          {(
            [
              [
                "inputs",
                "Readable sources",
                widgets.filter((w) => ACTION_DATA_TYPES.includes(w.type)),
              ],
              [
                "actions",
                "Callable forms",
                widgets.filter((w) => w.type === "form"),
              ],
            ] as const
          ).map(([key, label, list]) => (
            <fieldset
              key={key}
              className="rounded-xl border border-dx-line p-3"
            >
              <legend className="px-1 text-xs font-semibold">{label}</legend>
              {list.map((w) => (
                <label
                  key={w.id}
                  className="mb-2 flex items-start gap-2 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={op[key].includes(w.id)}
                    onChange={(e) =>
                      patch({
                        [key]: e.target.checked
                          ? [...op[key], w.id]
                          : op[key].filter((id) => id !== w.id),
                      })
                    }
                  />
                  <span>
                    {w.title}
                    <code className="block text-[10px] text-dx-muted">
                      {w.id} · {w.resource}
                    </code>
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
          <p className="text-xs text-dx-muted">
            <code>await studio.query("source-id", {"{limit:50}"})</code>
            <br />
            <code>await studio.action("form-id", values)</code>
            <br />
            Functions connected to onLoad cannot declare mutations.
          </p>
        </div>
      )}
      <div className="rounded-xl border border-dx-line p-3">
        <p className="text-xs font-semibold">Used by</p>
        {actionUsages(widgets, widget.id).length ? (
          actionUsages(widgets, widget.id).map((use) => (
            <p key={use} className="mt-1 text-xs text-dx-muted">
              {use}
            </p>
          ))
        ) : (
          <p className="mt-1 text-xs text-amber-600">
            Unconnected · assign this action to a widget event.
          </p>
        )}
      </div>
      {studioActionError(op) && <ModalError message={studioActionError(op)} />}
    </div>
  );
  return (
    <>
      <div className="space-y-3">
        <Field label="Action name">
          <input
            className={inputClassName}
            value={widget.title}
            maxLength={200}
            onChange={(e) => onChange({ title: e.target.value })}
          />
        </Field>
        <p className="flex items-center gap-2 rounded-lg bg-indigo-50 p-3 text-xs text-indigo-700 dark:bg-indigo-950">
          <Zap size={14} /> {LABELS[op.kind]}
        </p>
        <Button
          variant="primary"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          <Code2 size={14} /> Open Action Studio
        </Button>
        {settings}
      </div>
      <Modal
        studio
        open={open}
        title={`Action Studio · ${widget.title}`}
        eyebrow={`Action ${widget.id} · draft`}
        onClose={() => {
          setOpen(false);
          setRun(null);
        }}
        footer={
          <>
            <span className="mr-auto text-xs text-dx-muted">
              Changes affect this action. Save draft and Publish to release.
            </span>
            <Button
              onClick={() => {
                setOpen(false);
                setRun(null);
              }}
            >
              Done
            </Button>
          </>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <p className="mr-auto text-xs text-dx-muted">
            Preview uses sample inputs and simulated writes.
          </p>
          <Button disabled={!run} onClick={() => setRun(null)}>
            <Square size={13} /> Stop
          </Button>
          <Button variant="primary" onClick={launch}>
            <Play size={13} /> Run action preview
          </Button>
        </div>
        <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)_minmax(260px,0.7fr)]">
          <div className="max-h-[65vh] space-y-3 overflow-auto pr-2">
            <Field label="Action name">
              <input
                className={inputClassName}
                value={widget.title}
                onChange={(e) => onChange({ title: e.target.value })}
              />
            </Field>
            {settings}
          </div>
          <div className="min-w-0 space-y-3">
            <div
              role="tablist"
              aria-label="Action files"
              className="flex gap-1"
            >
              {(["function", "input", "fixtures"] as const)
                .filter((t) => op.kind === "function" || t !== "function")
                .map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    className={`rounded-lg px-3 py-2 text-xs font-semibold ${tab === t ? "bg-indigo-100 text-indigo-700" : "text-dx-muted"}`}
                    onClick={() => setTab(t)}
                  >
                    {t === "function"
                      ? "run.js"
                      : t === "input"
                        ? "Preview inputs"
                        : "Query fixtures"}
                  </button>
                ))}
            </div>
            <Suspense fallback={<p>Loading editor…</p>}>
              <CodeEditor
                label={
                  op.kind === "function" && tab === "function"
                    ? "Action function source"
                    : tab === "fixtures"
                      ? "Action query fixtures"
                      : "Action preview inputs"
                }
                language={
                  op.kind === "function" && tab === "function"
                    ? "javascript"
                    : "json"
                }
                value={
                  op.kind === "function" && tab === "function"
                    ? op.javascript
                    : tab === "fixtures"
                      ? fixtures
                      : context
                }
                onChange={(value) =>
                  op.kind === "function" && tab === "function"
                    ? patch({ javascript: value })
                    : tab === "fixtures"
                      ? setFixtures(value)
                      : setContext(value)
                }
              />
            </Suspense>
            <p className="text-xs leading-5 text-dx-muted">
              Input example:{" "}
              <code>
                {'{"widgets":{"edit-form":{"status":"done"}},"selected":null}'}
              </code>
              . Query fixtures are keyed by data widget ID. Stop ends the
              worker.
            </p>
          </div>
          <div className="min-w-0 space-y-3">
            <p className="text-xs font-semibold">Result & console</p>
            {error && <ModalError message={error} />}
            {run && (
              <CodeWidget
                key={run.id}
                code={run.code}
                title={widget.title}
                previewData={run.data}
                onResult={(value) => {
                  setResult({ value });
                  setRun(null);
                }}
                onLog={(entry) => {
                  setLogs((items) => [...items.slice(-49), entry]);
                  if (entry.level === "error") {
                    setError(entry.message);
                    setRun(null);
                  }
                }}
              />
            )}
            <pre
              aria-label="Action preview result"
              className="max-h-72 overflow-auto rounded-xl border border-dx-line bg-dx-subtle p-4 text-xs"
            >
              {result
                ? JSON.stringify(result.value, null, 2)
                : "Run this action to inspect its output."}
            </pre>
            <div
              role="log"
              aria-label="Action preview console"
              className="h-48 overflow-auto rounded-xl bg-slate-950 p-4 font-mono text-xs text-slate-200"
            >
              {logs.map((l, i) => (
                <p key={i} className="whitespace-pre-wrap break-words">
                  [{l.level}] {l.message}
                </p>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
