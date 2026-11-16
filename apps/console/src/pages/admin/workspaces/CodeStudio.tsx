// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { Code2, Play, Square, Check, Terminal } from "lucide-react";
import { Modal, ModalError } from "../../../components/Modal";
import { Button } from "../../../components/ui";
import { CodeEditor } from "../../../components/workspaces/CodeEditor";
import {
  CodeWidget,
  type StudioLog,
} from "../../../components/workspaces/CodeWidget";
import {
  studioCodeError,
  type StudioCode,
  type WorkspaceWidget,
} from "../../../lib/workspaces";

import { STARTER_CODE } from "../../../lib/studioCode";

export function CodeStudio({
  widget,
  widgets,
  onChange,
}: {
  widget: WorkspaceWidget;
  widgets: WorkspaceWidget[];
  onChange: (patch: Partial<WorkspaceWidget>) => void;
}) {
  const [open, setOpen] = useState(false),
    [source, setSource] = useState<StudioCode>(widget.code || STARTER_CODE);
  const [file, setFile] = useState<"html" | "css" | "javascript" | "fixtures">(
    "javascript",
  );
  const [fixtures, setFixtures] = useState("{}"),
    [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<{
    id: number;
    code: StudioCode;
    data: Record<string, unknown>;
  } | null>(null);
  const [logs, setLogs] = useState<StudioLog[]>([]),
    [example, setExample] = useState("interactive");
  const inputs = widgets.filter((w) =>
    ["metric", "table", "chart", "list", "map", "kanban", "timeline"].includes(
      w.type,
    ),
  );
  const actions = widgets.filter((w) => w.type === "form");
  const initial = JSON.stringify(widget.code || STARTER_CODE);
  const close = () => {
    if (
      JSON.stringify(source) !== initial &&
      !window.confirm("Discard unapplied code changes?")
    )
      return;
    setOpen(false);
    setRun(null);
  };
  const launch = () => {
    setError(null);
    const issue = studioCodeError(source);
    if (issue) {
      setError(issue);
      return;
    }
    try {
      const data = JSON.parse(fixtures);
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Preview data must be an object keyed by widget id");
      setLogs([]);
      setRun({ id: Date.now(), code: structuredClone(source), data });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const insertExample = () => {
    const code = structuredClone(STARTER_CODE);
    if (example === "data") {
      const id = source.inputs[0] || inputs[0]?.id;
      if (!id) {
        setError("Add a data widget to this page first.");
        return;
      }
      code.inputs = [id];
      code.html = '<section class="card"><h2>Loading summary…</h2></section>';
      code.javascript = `// Query an installed widget using the current member's permissions.\nconst data = await studio.query(${JSON.stringify(id)}, { limit: 50 });\nconst total = data.total ?? data.count ?? data.rows?.length ?? 0;\nstudio.render(\`<section class="card"><small>LIVE SUMMARY</small><h2>\${Number(total)} records</h2><p>Loaded through the page data binding.</p></section>\`);\nconsole.log("Query result", data);`;
      setFixtures(
        JSON.stringify(
          {
            [id]: {
              rows: [{ id: "sample-1", name: "Preview record" }],
              total: 1,
              count: 1,
            },
          },
          null,
          2,
        ),
      );
    } else if (example === "action") {
      const id = source.actions[0] || actions[0]?.id;
      if (!id) {
        setError("Add a form with an authorized action to this page first.");
        return;
      }
      code.actions = [id];
      code.html =
        '<section class="card"><h2>Custom action</h2><p>Adapt the values object to your form fields.</p><button data-event="submit">Run action</button></section>';
      code.javascript = `studio.on("submit", async () => {\n  // Match the declared form fields. Runtime asks the member to confirm.\n  const values = { notes: "Submitted from my custom component" };\n  const result = await studio.action(${JSON.stringify(id)}, values);\n  console.log("Action result", result);\n});`;
    }
    setSource(code);
    setError(null);
    setRun(null);
  };
  return (
    <>
      <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-900 dark:bg-indigo-950/40">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Code2 size={16} />
          Custom component
        </p>
        <p className="my-2 text-xs leading-5 text-dx-muted">
          Write HTML, CSS and JavaScript for this widget. Connect it to your
          page’s data and actions.
        </p>
        <Button
          variant="primary"
          onClick={() => {
            setSource(structuredClone(widget.code || STARTER_CODE));
            setFixtures(
              JSON.stringify(
                Object.fromEntries(
                  inputs
                    .filter((w) => (widget.code?.inputs || []).includes(w.id))
                    .map((w) => [w.id, { rows: [], total: 0, count: 0 }]),
                ),
                null,
                2,
              ),
            );
            setError(null);
            setOpen(true);
          }}
        >
          Open Code Studio
        </Button>
      </div>
      <Modal
        open={open}
        studio
        title={`Code Studio · ${widget.title}`}
        eyebrow={`Widget ${widget.id} · draft`}
        onClose={close}
        footer={
          <>
            <span className="mr-auto text-xs text-dx-muted">
              Changes apply only to this widget. Then Save draft and Publish.
            </span>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                const issue = studioCodeError(source);
                if (issue) {
                  setError(issue);
                  return;
                }
                onChange({ code: structuredClone(source) });
                setOpen(false);
                setRun(null);
              }}
            >
              <Check size={14} />
              Apply code
            </Button>
          </>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <select
            aria-label="Code example"
            className="rounded-lg border border-dx-line bg-dx-subtle p-2 text-xs"
            value={example}
            onChange={(e) => setExample(e.target.value)}
          >
            <option value="interactive">Interactive card</option>
            <option value="data">Data summary</option>
            <option value="action">Action button</option>
          </select>
          <Button onClick={insertExample}>Insert example</Button>
          <div className="ml-auto flex gap-2">
            <Button onClick={() => setRun(null)} disabled={!run}>
              <Square size={13} />
              Stop
            </Button>
            <Button variant="primary" onClick={launch}>
              <Play size={13} />
              Run preview
            </Button>
          </div>
        </div>
        {error ? <ModalError message={error} /> : null}
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="min-w-0">
            <div
              className="mb-2 flex gap-1"
              role="tablist"
              aria-label="Code files"
            >
              {(["html", "css", "javascript", "fixtures"] as const).map(
                (name) => (
                  <button
                    key={name}
                    role="tab"
                    aria-selected={file === name}
                    onClick={() => setFile(name)}
                    className={`rounded-lg px-3 py-2 text-xs font-semibold ${file === name ? "bg-indigo-100 text-indigo-700" : "text-dx-muted"}`}
                  >
                    {name === "fixtures"
                      ? "Preview data"
                      : name === "javascript"
                        ? "JavaScript"
                        : name.toUpperCase()}
                  </button>
                ),
              )}
            </div>
            <CodeEditor
              language={file === "fixtures" ? "json" : file}
              label={
                file === "fixtures" ? "Preview data JSON" : `${file} source`
              }
              value={file === "fixtures" ? fixtures : source[file]}
              onChange={(value) =>
                file === "fixtures"
                  ? setFixtures(value)
                  : setSource({ ...source, [file]: value })
              }
            />
            <details className="mt-3 rounded-xl border border-dx-line p-3" open>
              <summary className="cursor-pointer text-xs font-semibold">
                Data & action bindings
              </summary>
              <div className="mt-3 grid grid-cols-2 gap-4 text-xs">
                {(
                  [
                    ["inputs", inputs],
                    ["actions", actions],
                  ] as const
                ).map(([key, list]) => (
                  <div key={key}>
                    <p className="mb-2 font-semibold">
                      {key === "inputs" ? "Readable widgets" : "Callable forms"}
                    </p>
                    {list.length ? (
                      list.map((w) => (
                        <label
                          key={w.id}
                          className="mb-2 flex items-start gap-2"
                        >
                          <input
                            type="checkbox"
                            checked={source[key].includes(w.id)}
                            onChange={(e) =>
                              setSource({
                                ...source,
                                [key]: e.target.checked
                                  ? [...source[key], w.id]
                                  : source[key].filter((id) => id !== w.id),
                              })
                            }
                          />
                          <span>
                            {w.title}
                            {w.workflowArtifactId ? (
                              <a
                                className="ml-2 text-indigo-600 underline"
                                href={`/admin/workflows?artifact=${encodeURIComponent(w.workflowArtifactId)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Edit server logic
                              </a>
                            ) : null}
                            <code className="block text-[10px] text-dx-muted">
                              {w.id}
                            </code>
                          </span>
                        </label>
                      ))
                    ) : (
                      <p className="text-dx-muted">
                        Add {key === "inputs" ? "a data widget" : "a form"} to
                        this page first.
                      </p>
                    )}
                  </div>
                ))}
              </div>
              <label className="mt-3 flex items-center gap-2 text-xs">
                Height (px)
                <input
                  aria-label="Code height"
                  type="number"
                  min={120}
                  max={1200}
                  className="w-24 rounded border border-dx-line bg-dx-subtle p-2"
                  value={source.height}
                  onChange={(e) =>
                    setSource({ ...source, height: Number(e.target.value) })
                  }
                />
              </label>
            </details>
          </div>
          <div className="min-w-0 space-y-3">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span>Live preview</span>
              <span className="rounded-full bg-teal-50 px-3 py-1 text-teal-700">
                Sample data · simulated actions
              </span>
            </div>
            {run ? (
              <CodeWidget
                key={run.id}
                code={run.code}
                title={widget.title}
                previewData={run.data}
                onLog={(entry) =>
                  setLogs((items) => [...items.slice(-99), entry])
                }
              />
            ) : (
              <div className="flex h-[300px] items-center justify-center rounded-xl border border-dashed border-dx-line bg-dx-subtle text-sm text-dx-muted">
                Run preview to test this component.
              </div>
            )}
            <div className="overflow-hidden rounded-xl bg-[#101b2c] text-slate-200">
              <p className="flex items-center gap-2 border-b border-slate-700 px-4 py-3 text-xs font-semibold">
                <Terminal size={14} />
                Console
              </p>
              <div
                role="log"
                aria-label="Code console"
                className="h-40 overflow-auto p-4 font-mono text-xs"
              >
                {logs.length ? (
                  logs.map((entry, i) => (
                    <p
                      key={i}
                      className={`mb-2 whitespace-pre-wrap break-words ${entry.level === "error" ? "text-red-300" : entry.level === "warn" ? "text-amber-300" : ""}`}
                    >
                      [{entry.level}] {entry.message}
                    </p>
                  ))
                ) : (
                  <p className="text-slate-500">Logs and errors appear here.</p>
                )}
              </div>
            </div>
            <details
              className="rounded-xl border border-dx-line p-4 text-xs leading-6"
              open
            >
              <summary className="cursor-pointer font-semibold">
                Studio JavaScript API
              </summary>
              <p>
                <code>
                  await studio.query(widgetId, &#123;limit, offset,
                  search&#125;)
                </code>{" "}
                reads a bound widget.
              </p>
              <p>
                <code>await studio.action(formId, values)</code> requests a
                bound action.
              </p>
              <p>
                <code>studio.on(eventName, callback)</code> handles{" "}
                <code>data-event</code> controls.
              </p>
              <p>
                <code>studio.render(html)</code> updates the component with
                sanitized HTML.
              </p>
              <p className="mt-2 text-dx-muted">
                JavaScript supports async/await, functions and local state in an
                isolated worker. Use the Studio API to update the UI; DOM,
                network, credentials and external packages are unavailable.
                Workflow business rules continue to run on the server.
              </p>
            </details>
          </div>
        </div>
      </Modal>
    </>
  );
}
