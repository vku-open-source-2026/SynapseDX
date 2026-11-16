import { flushSync } from "react-dom";
// SPDX-License-Identifier: Apache-2.0
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, ModalError } from "../Modal";
import { Button } from "../ui";
import { CodeWidget } from "./CodeWidget";
import { RecordSelection } from "./RecordSelection";
import { WorkspaceNavigation, WorkspaceModules } from "./WorkspaceNavigation";
import {
  safeCellText,
  type RuntimeWidget,
  type StudioCode,
  type WidgetData,
} from "../../lib/workspaces";
import {
  compileStudioAction,
  defaultActionContext,
  resolveActionValues,
} from "../../lib/studioActionRuntime";
import { uploadWidgetFile, downloadWidgetFile, fetchWidgetData, executeFormWidget } from "../../lib/workspacesApi";
import { fetchReferenceOptions } from "../../lib/workspacesApi";
import { actionReferenceErrors, MAX_ACTION_EXECUTIONS } from "../../lib/studioActions";

type FormSetter = (values: Record<string, unknown> | null) => void;
export const WorkspaceActions = createContext<{
  queryKey: (id: string) => string;
  capture: (id: string, values: Record<string, unknown>) => void;
  captureData: (id: string, data: WidgetData) => void;
  registerForm: (id: string, setter: FormSetter) => () => void;
  run: (
    id: string,
    event?: Record<string, unknown>,
    options?: { silent?: boolean },
  ) => Promise<unknown>;
} | null>(null);
export function WorkspaceActionProvider({
  installedId,
  widgets,
  cacheScope,
  product,
  openForm,
  children,
}: {
  installedId: string;
  widgets: RuntimeWidget[];
  cacheScope: string;
  product: string;
  openForm: (widget: RuntimeWidget) => void;
  children: ReactNode;
}) {
  const selection = useContext(RecordSelection),
    pages = useContext(WorkspaceNavigation),
    modules = useContext(WorkspaceModules);
  const queryClient = useQueryClient();
  const state = useRef({ widgets, selection, pages, modules, openForm });
  state.current = { widgets, selection, pages, modules, openForm };
  const input = useRef(defaultActionContext(widgets).widgets),
    data = useRef<Record<string, WidgetData>>({}),
    forms = useRef<Record<string, FormSetter>>({});
  const [, setInputRevision] = useState(0);
  const capture = useCallback((id: string, values: Record<string, unknown>) => {
    if (JSON.stringify(input.current[id]) === JSON.stringify(values)) return;
    input.current[id] = values;
    setInputRevision(value => value + 1);
  }, []);
  const queryKey = useCallback((id: string) => {
    const current = state.current;
    const op = current.widgets.find(w => w.id === id)?.operation;
    if (!op) return "missing";
    try { return JSON.stringify(resolveActionValues(op, { widgets: input.current, selected: current.selection.selected }, current.widgets)); }
    catch (error) { return String(error); }
  }, []);
  const captureData = useCallback((id: string, value: WidgetData) => {
    data.current[id] = value;
  }, []);
  const registerForm = useCallback((id: string, setter: FormSetter) => {
    forms.current[id] = setter;
    return () => {
      delete forms.current[id];
    };
  }, []);
  const [notice, setNotice] = useState<{
    title: string;
    error?: string;
    message?: string;
    result?: unknown;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    values: unknown;
    deleting: boolean;
  } | null>(null);
  const [deleteChecked, setDeleteChecked] = useState(false);
  const confirmRef = useRef<((accepted: boolean) => void) | null>(null);
  const disposed = useRef(false);
  const functionQueue = useRef<Promise<unknown>>(Promise.resolve());
  const functionRef = useRef<{
    resolve: (value: unknown) => void;
    reject: (e: Error) => void;
  } | null>(null);
  const [source, setSource] = useState<{
    id: string;
    code: StudioCode;
    title: string;
    key: number;
    quiet: boolean;
  } | null>(null);
  const settleFunction = (value: unknown, error?: string) => {
    const pending = functionRef.current;
    functionRef.current = null;
    setSource(null);
    if (error) pending?.reject(new Error(error));
    else pending?.resolve(value);
  };
  const confirm = (title: string, values: unknown, deleting: boolean) =>
    new Promise<boolean>((resolve) => {
      if (confirmRef.current) {
        resolve(false);
        return;
      }
      confirmRef.current = resolve;
      setDeleteChecked(false);
      setConfirmation({ title, values, deleting });
    });
  const answer = (accepted: boolean) => {
    confirmRef.current?.(accepted);
    confirmRef.current = null;
    setConfirmation(null);
  };
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      confirmRef.current?.(false);
      functionRef.current?.reject(new Error("Action stopped"));
    };
  }, []);
  const run = useCallback(
    async (
      id: string,
      event: Record<string, unknown> = {},
      options: { silent?: boolean } = {},
    ) => {
      const results: Record<string, unknown> = {};
      let executions = 0;
      const execute = async (actionId: string, depth = 0): Promise<unknown> => {
        if (disposed.current) throw new Error("Page changed; action stopped");
        if (depth > 12) throw new Error("Action chain exceeds 12 levels");
        if (++executions > MAX_ACTION_EXECUTIONS) throw new Error("Action chain exceeds 128 executions");
        const current = state.current;
        const action = current.widgets.find(
            (w) => w.type === "action" && w.id === actionId,
          ),
          op = action?.operation;
        if (!action || !op)
          throw new Error(
            "Choose an action from this page’s published registry",
          );
        const target = current.widgets.find((w) => w.id === op.target);
        const context = {
          widgets: input.current,
          selected: current.selection.selected,
          event,
          results,
        };
        const values = resolveActionValues(op, context, current.widgets);
        let value: unknown;
        switch (op.kind) {
          case "upload": {
            if (!target?.canSubmit || !(event.file instanceof File)) throw new Error("Choose a file in an available form");
            value = await uploadWidgetFile(installedId, target.id, actionId, event.file);
            await queryClient.invalidateQueries({ queryKey: ["workspace-widget", cacheScope, installedId] });
            break;
          }
          case "download": {
            if (!target) throw new Error("Choose a file source");
            const blob = await downloadWidgetFile(installedId, target.id, actionId, values);
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a"); link.href = url;
            const row = current.selection.selected?.row;
            link.download = String(row?.filename || row?.name || "download").replace(/[/\\\x00-\x1f]/g, "_");
            link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            value = { downloaded: values.file_id, size: blob.size }; break;
          }
          case "query":
            if (target?.type === "form") {
              const field = target.fields?.find(f => f.optionsResource === op.source && f.optionsAction === actionId);
              if (!field) throw new Error("Choose a matching published reference query");
              value = await fetchReferenceOptions(installedId, target.id, field.name, actionId, values);
              break;
            }
            if (!target || target.resource !== op.source)
              throw new Error(
                "Query source does not match its published binding",
              );
            value = await fetchWidgetData(
              installedId,
              target,
              values,
              actionId,
            );
            break;
          case "create":
          case "update":
          case "delete":
          case "batch":
          case "execute": {
            if (!target?.canSubmit)
              throw new Error("This form is unavailable for your role");
            if (
              !(await confirm(
                `Confirm ${target.title}`,
                values,
                op.kind === "delete",
              ))
            )
              throw new Error("Action cancelled");
            if (op.kind === "batch") {
              let offset = Number(values[op.source!] || 0), batches = 0, imported = 0, skipped = 0, invalid = 0;
              const errors: unknown[] = [];
              if (!Number.isInteger(offset) || offset < 0) throw new Error("Batch offset must be a nonnegative integer");
              while (true) {
                if (disposed.current) throw new Error("Page changed; batch processing stopped");
                if (++executions > MAX_ACTION_EXECUTIONS) throw new Error(`Batch action limit reached after ${batches} batches. Resume at offset ${offset}.`);
                let receipt: any;
                try { receipt = await executeFormWidget(installedId, target.id, { ...values, [op.source!]: offset }, actionId); }
                catch (error) { throw new Error(`Batch stopped at offset ${offset}. ${(error as Error).message}. Completed batches: ${batches}; imported: ${imported}; skipped: ${skipped}; invalid: ${invalid}.`); }
                if (!receipt.completed) throw new Error(`Batch is still processing (${receipt.executionId}). Check its result before resuming at offset ${offset}.`);
                const result = receipt.result;
                if (!result || typeof result !== "object") throw new Error("Batch workflow must return a result object");
                batches++; imported += Number(result.imported || 0); skipped += Number(result.skipped || 0); invalid += Number(result.invalid || 0);
                errors.push(...(Array.isArray(result.errors) ? result.errors.slice(0, Math.max(0, 200 - errors.length)) : []));
                value = { completed: true, result: { ...result, batches, imported, skipped, invalid, errors } };
                if (result.nextOffset === undefined || result.nextOffset === null) break;
                if (!Number.isInteger(result.nextOffset) || result.nextOffset <= offset) throw new Error("Batch workflow returned a nonadvancing offset");
                offset = result.nextOffset;
                input.current[target.id] = { ...input.current[target.id], [op.source!]: offset };
                forms.current[target.id]?.({ [op.source!]: offset });
              }
            } else value = await executeFormWidget(installedId, target.id, values, actionId);
            await Promise.all(
              ["workspace-widget", "workspace-record"].map((key) =>
                queryClient.invalidateQueries({
                  queryKey: [key, cacheScope, installedId],
                }),
              ),
            );
            await queryClient.invalidateQueries({
              queryKey: ["workspace-reference", installedId],
            });
            break;
          }
          case "navigate": {
            const [kind, key] = op.destination!.split(":");
            if (kind === "page" && !current.pages?.includes(key))
              throw new Error("This page is unavailable for your membership");
            if (kind === "module" && !current.modules?.includes(key))
              throw new Error("This module is unavailable for your membership");
            if (
              kind === "section" &&
              !current.widgets.some((w) => w.section === key)
            )
              throw new Error("Unknown section");
            const params = new URLSearchParams({
              product,
              page:
                kind === "page"
                  ? key
                  : kind === "module"
                    ? `${product}-common-workspace`
                    : new URLSearchParams(location.search).get("page") ||
                      `${product}-common-workspace`,
            });
            if (kind !== "page")
              params.set(kind === "section" ? "section" : "module", key);
            location.assign(`/workspace?${params}`);
            value = { destination: op.destination };
            break;
          }
          case "openForm":
            if (!target) throw new Error("Form unavailable");
            flushSync(() => current.openForm(target));
            value = { opened: target.id };
            break;
          case "showRecord":
            if (!target || !event.row || typeof event.row !== "object")
              throw new Error("Select a row first");
            current.selection.select(
              target.resource || "",
              event.row as Record<string, unknown>,
              { widgetId: target.id, actionId },
            );
            value = event.row;
            break;
          case "refresh":
            await queryClient.invalidateQueries({
              queryKey: [
                "workspace-widget",
                cacheScope,
                installedId,
                op.target,
              ],
            });
            value = { refreshed: op.target };
            break;
          case "resetForm":
          case "setValues":
            if (!forms.current[op.target!])
              throw new Error("Open the target form first");
            input.current[op.target!] =
              op.kind === "resetForm"
                ? defaultActionContext(current.widgets).widgets[op.target!] ||
                  {}
                : { ...input.current[op.target!], ...values };
            forms.current[op.target!](op.kind === "resetForm" ? null : values);
            value = { updated: op.target };
            break;
          case "notify":
            setNotice({
              title: action.title,
              message: op.message || "Action completed",
            });
            value = { message: op.message };
            break;
          case "export": {
            const source = data.current[op.target!];
            if (!source || !target)
              throw new Error("Load this data widget before exporting");
            const columns = target.columns || source.columns;
            const cell = (v: unknown) => {
              let text = safeCellText(v, 10000);
              if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
              return '"' + text.replaceAll('"', '""') + '"';
            };
            const csv = [
              columns,
              ...source.rows.map((row) => columns.map((c) => row[c])),
            ]
              .map((row) => row.map(cell).join(","))
              .join("\r\n");
            const url = URL.createObjectURL(
              new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }),
            );
            const a = document.createElement("a");
            a.href = url;
            a.download = `${target.resource || target.id}-current-page.csv`;
            a.click();
            URL.revokeObjectURL(url);
            value = { exported: source.rows.length };
            break;
          }
          case "sequence":
            for (const step of op.steps || [])
              value = await execute(step, depth + 1);
            break;
          case "condition": {
            const first = Object.values(values)[0];
            const compare = op.compareValue || "";
            const match =
              op.comparison === "exists"
                ? first !== undefined && first !== null && first !== ""
                : op.comparison === "equals"
                  ? String(first) === compare
                  : op.comparison === "notEquals"
                    ? String(first) !== compare
                    : op.comparison === "greater"
                      ? Number(first) > Number(compare)
                      : Number(first) < Number(compare);
            const next = match ? op.then : op.otherwise;
            value = next ? await execute(next, depth + 1) : null;
            break;
          }
          case "function": {
            const code = compileStudioAction(op, context, current.widgets);
            const pending = functionQueue.current.then(
              () =>
                new Promise((resolve, reject) => {
                  if (disposed.current) {
                    reject(new Error("Page changed; action stopped"));
                    return;
                  }
                  const timer = window.setTimeout(() => {
                    functionRef.current = null;
                    setSource(null);
                    reject(new Error("Function exceeded 30 seconds"));
                  }, 30000);
                  functionRef.current = {
                    resolve: (value) => {
                      clearTimeout(timer);
                      resolve(value);
                    },
                    reject: (error) => {
                      clearTimeout(timer);
                      reject(error);
                    },
                  };
                  setSource({
                    id: actionId,
                    code,
                    title: action.title,
                    key: Date.now(),
                    quiet: !!options.silent,
                  });
                }),
            );
            functionQueue.current = pending.catch(() => {});
            value = await pending;
            break;
          }
        }
        results[actionId] = value;
        return value;
      };
      try {
        // Validate the entire registry before the first step can mutate data.
        const issues = actionReferenceErrors(state.current.widgets);
        if (issues.length) throw new Error(issues[0]);
        const result = await execute(id);
        if (
          !options.silent &&
          !["notify", "openForm", "showRecord", "navigate", "export"].includes(
            state.current.widgets.find((w) => w.id === id)?.operation?.kind ||
              "",
          )
        )
          setNotice({
            title:
              state.current.widgets.find((w) => w.id === id)?.title ||
              "Action completed",
            result,
          });
        return result;
      } catch (e) {
        if (!options.silent)
          setNotice({
            title: "Action unavailable",
            error: (e as Error).message,
          });
        throw e;
      }
    },
    [installedId, cacheScope, product, queryClient],
  );
  return (
    <WorkspaceActions.Provider
      value={{ capture, captureData, registerForm, run, queryKey }}
    >
      {children}
      {source && (
        <div className="sr-only">
          <CodeWidget
            key={source.key}
            code={source.code}
            title={source.title}
            installedId={installedId}
            actionId={source.id}
            widgets={widgets}
            cacheScope={cacheScope}
            onResult={(value) => settleFunction(value)}
            onLog={(entry) => {
              if (entry.level === "error") settleFunction(null, entry.message);
            }}
          />
        </div>
      )}
      <Modal
        open={!!source && !source.quiet}
        onClose={() => settleFunction(null, "Action stopped")}
        title={source?.title || "Function"}
        footer={
          <Button onClick={() => settleFunction(null, "Action stopped")}>
            Stop function
          </Button>
        }
      >
        <p className="text-sm text-dx-muted">
          Running the published function with its declared data and form
          bindings.
        </p>
      </Modal>
      <Modal
        open={!!confirmation}
        onClose={() => answer(false)}
        title={confirmation?.title || "Confirm action"}
        footer={
          <>
            <Button onClick={() => answer(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!!confirmation?.deleting && !deleteChecked}
              onClick={() => answer(true)}
            >
              Confirm action
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-dx-muted">
          Submit these values through the published action.
        </p>
        <pre className="max-h-72 overflow-auto rounded-xl bg-dx-subtle p-3 text-xs">
          {JSON.stringify(confirmation?.values, null, 2)}
        </pre>
        {confirmation?.deleting && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={deleteChecked}
              onChange={(e) => setDeleteChecked(e.target.checked)}
            />
            I confirm deletion.
          </label>
        )}
      </Modal>
      <Modal
        open={!!notice}
        title={notice?.title || "Action"}
        onClose={() => setNotice(null)}
      >
        {notice?.error ? (
          <ModalError message={notice.error} />
        ) : notice?.result !== undefined ? (
          <pre
            aria-label="Action result"
            className="max-h-80 overflow-auto rounded-xl bg-dx-subtle p-4 text-xs"
          >
            {JSON.stringify(notice.result, null, 2)}
          </pre>
        ) : (
          <p>{notice?.message}</p>
        )}
      </Modal>
    </WorkspaceActions.Provider>
  );
}
