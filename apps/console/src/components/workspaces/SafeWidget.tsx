import { ChartWidget } from "./ChartWidget";
import { WorkspaceActions } from "./WorkspaceActions";
import { fieldInput } from "../../lib/studioActionRuntime";
import { BoundField } from "./BoundField";
import { KanbanView, TimelineView, MarkdownView } from "./CollectionViews";
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * The only renderer for declarative workspace widgets. Text is always a React
 * text node (never HTML), tables only read declared columns and forms submit
 * only when the backend advertises validated write support.
 */
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  BarChart3,
  Table2,
  Type as TypeIcon,
  ClipboardList,
  Send,
  Navigation,
  MousePointer2,
  PanelsTopLeft,
  ChartNoAxesColumn,
  List,
  Info,
  Gauge,
} from "lucide-react";
import { Button, Card, EmptyState, Skeleton } from "../ui";
import { formatNumber } from "../../lib/format";
import {
  formDisabledReason,
  isFormWritable,
  safeCellText,
  type RuntimeWidget,
  type WidgetData,
  type WorkspaceFormAction,
} from "../../lib/workspaces";
import { WorkspaceModules, WorkspaceNavigation } from "./WorkspaceNavigation";
import { MapWidget } from "./MapWidget";
import { RecordTable } from "./RecordTable";
import { RecordSelection } from "./RecordSelection";
import { cn } from "../../lib/utils";

export interface SafeWidgetProps {
  installedId?: string;
  widget: RuntimeWidget;
  data?: WidgetData;
  dataLoading?: boolean;
  dataError?: string | null;
  preview?: boolean;
  product?: string;
  formUnavailableReason?: string | null;
  onFormSubmit?: (values: Record<string, unknown>) => Promise<unknown>;
  formBusy?: boolean;
}

const ICONS: Partial<Record<RuntimeWidget["type"], typeof TypeIcon>> = {
  text: TypeIcon,
  metric: BarChart3,
  table: Table2,
  form: ClipboardList,
  navigation: Navigation,
  button: MousePointer2,
  tabs: PanelsTopLeft,
  chart: ChartNoAxesColumn,
  list: List,
  alert: Info,
  progress: Gauge,
};

const ACTION_LABELS: Record<WorkspaceFormAction, string> = {
  create: "Submit",
  update: "Submit update",
  delete: "Request deletion",
  execute: "Run action",
};

function WidgetShell({
  widget,
  children,
  footer,
}: {
  widget: RuntimeWidget;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const Icon = ICONS[widget.type] ?? TypeIcon;
  return (
    <Card
      className={cn(
        "flex flex-1 flex-col p-4",
        widget.width === "full" ? "sm:col-span-2" : "",
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <Icon
            size={16}
            className="shrink-0 text-sky-600 dark:text-sky-400"
            aria-hidden="true"
          />
          <span className="truncate">{widget.title}</span>
        </h3>
        {widget.resource ? (
          <span
            className="h-1.5 w-1.5 rounded-full bg-indigo-400"
            title="Connected data"
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
      {footer ? (
        <div className="mt-3 text-[11px] text-slate-500 dark:text-slate-400">
          {footer}
        </div>
      ) : null}
    </Card>
  );
}

function WidgetFeedback({
  message,
  tone = "neutral",
}: {
  message: string;
  tone?: "neutral" | "bad";
}) {
  return (
    <p
      className={cn(
        "rounded-lg px-3 py-2 text-xs leading-5",
        tone === "bad"
          ? "border border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
          : "border border-slate-200 bg-slate-50 text-slate-600 dark:border-[#26354d] dark:bg-[#142136] dark:text-slate-300",
      )}
    >
      {message}
    </p>
  );
}

function TextWidget({ widget }: { widget: RuntimeWidget }) {
  if (!widget.text) {
    return (
      <p className="text-sm italic text-slate-400 dark:text-slate-500">
        This text widget has no content yet.
      </p>
    );
  }
  return (
    <p className="whitespace-pre-line break-words text-sm leading-6 text-slate-700 dark:text-slate-300">
      {widget.text}
    </p>
  );
}

function MetricWidget({
  data,
  loading,
  error,
  preview,
}: {
  widget: RuntimeWidget;
  data?: WidgetData;
  loading?: boolean;
  error?: string | null;
  preview?: boolean;
}) {
  if (preview) {
    return (
      <div className="space-y-2">
        <p className="text-3xl font-semibold tracking-tight text-slate-300 dark:text-slate-600">
          —
        </p>
        <WidgetFeedback message="The live count loads in /workspace after this page is published and installed." />
      </div>
    );
  }
  if (loading) return <Skeleton className="h-14 w-32" />;
  if (error)
    return <WidgetFeedback tone="bad" message={`Data unavailable: ${error}`} />;
  return (
    <div>
      <p className="text-3xl font-semibold tracking-tight text-slate-900 tabular-nums dark:text-slate-100">
        {formatNumber(data?.total ?? 0)}
      </p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Current total
      </p>
    </div>
  );
}

function FormWidget({
  widget,
  preview,
  unavailableReason,
  onSubmit,
  busy,
  installedId,
}: {
  widget: RuntimeWidget;
  preview?: boolean;
  unavailableReason?: string | null;
  onSubmit?: (values: Record<string, unknown>) => Promise<unknown>;
  busy?: boolean;
  installedId?: string;
}) {
  const prefix = useId();
  const pageActions = useContext(WorkspaceActions);
  const { selected } = useContext(RecordSelection);
  const fields = widget.fields ?? [];
  const writable = isFormWritable(widget);
  const editedFields = useRef(new Set<string>());
  const selectedKey = useRef<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((field) => [field.name, field.defaultValue || ""]),
    ),
  );
  useEffect(() => {
    if (preview || !pageActions) return;
    const payload = Object.fromEntries(
      fields.map((f) => {
        try {
          return [f.name, fieldInput(f.type, values[f.name] ?? "")];
        } catch {
          return [f.name, undefined];
        }
      }),
    );
    pageActions.capture(widget.id, payload);
  }, [values, widget.id, pageActions?.capture, preview]);
  useLayoutEffect(
    () =>
      pageActions?.registerForm(widget.id, (patch) => {
        if (patch === null) editedFields.current.clear();
        else Object.keys(patch).forEach(key => editedFields.current.add(key));
        setValues((current) =>
          patch === null
            ? Object.fromEntries(
                fields.map((f) => [f.name, f.defaultValue || ""]),
              )
            : {
                ...current,
                ...Object.fromEntries(
                  Object.entries(patch)
                    .filter(([key]) => fields.some((f) => f.name === key))
                    .map(([key, value]) => [
                      key,
                      typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value ?? ""),
                    ]),
                ),
              },
        );
      }),
    [pageActions?.registerForm, widget.id],
  );
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (!selected) {
      selectedKey.current = null;
      editedFields.current.clear();
      return;
    }
    if (
      selected.resource !== widget.resource ||
      widget.action === "create"
    )
      return;
    const row = selected.row;
    const key = JSON.stringify([widget.id, selected.resource, row.id, selected.widgetId, selected.actionId]);
    if (selectedKey.current !== key) editedFields.current.clear();
    selectedKey.current = key;
    setValues(current => ({
      ...current,
      ...Object.fromEntries(
        fields.map((field, index) => {
          if (editedFields.current.has(field.name)) return [field.name, current[field.name] ?? ""];
          const bound = field.selectionPath
            ? field.selectionPath.split(".").reduce<unknown>((value, key) => value && typeof value === "object" && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined, row)
            : field.name === "record_id" || (field.type !== "file" && index === 0 && /_id$/.test(field.name)) ? row.id : row[field.name];
          const value = bound ?? field.defaultValue ?? "";
          return [field.name, typeof value === "object" ? JSON.stringify(value) : field.type === "date" ? String(value).slice(0, 10) : String(value)];
        }),
      ),
    }));
    setSaved(false);
    setConfirmed(false);
  }, [selected, widget.id]);
  const [error, setError] = useState<string | null>(null);
  const disabledReason = formDisabledReason(widget);
  const disabled =
    !writable || !widget.onSubmit || preview || !onSubmit || Boolean(busy);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || submitting || (widget.action === "delete" && !confirmed))
      return;
    setError(null);
    setSaved(false);

    const payload: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = (values[field.name] ?? "").trim();
      if (field.required && !raw) {
        setError(`${field.label} is required.`);
        return;
      }
      if (!raw) continue;
      if (field.type === "checkbox") {
        payload[field.name] = raw === "true";
      } else if (field.type === "number") {
        const number = Number(raw);
        if (!Number.isFinite(number)) {
          setError(`${field.label} must be a number.`);
          return;
        }
        payload[field.name] = number;
      } else {
        payload[field.name] = raw;
      }
    }

    setSubmitting(true);
    try {
      const response = await onSubmit?.(payload);
      setResult(response);
      setSaved(true);
    } catch (failure) {
      setError(
        (failure as Error)?.message || "The record could not be created.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (fields.length === 0) {
    return (
      <WidgetFeedback message="This action is not configured. Contact your administrator." />
    );
  }

  const statusMessage = preview
    ? "Preview only. The form submits in /workspace after the page is published and installed, and only when the backend authorizes the action."
    : !writable
      ? unavailableReason || disabledReason || "This form is read-only."
      : disabled
        ? "This form cannot submit in this environment."
        : null;

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      {statusMessage ? (
        <WidgetFeedback
          tone={!preview && !writable ? "bad" : "neutral"}
          message={statusMessage}
        />
      ) : null}
      <fieldset
        disabled={disabled || submitting}
        className="space-y-3 disabled:opacity-60"
      >
        {fields.map((field) => {
          const id = `${prefix}-${field.name}`;
          const setValue = (next: string) => {
            editedFields.current.add(field.name);
            setValues((current) => ({ ...current, [field.name]: next }));
            setSaved(false);
          };
          return (
            <label
              key={JSON.stringify([field.name, widget.action !== "create" && selected && selected.resource === widget.resource ? selected.row.id : null])}
              htmlFor={id}
              className="block text-sm font-medium text-slate-700 dark:text-slate-200"
            >
              <span>
                {field.label}
                {field.required ? (
                  <span className="ml-0.5 text-red-500">*</span>
                ) : null}
              </span>
              <div className="mt-1.5">
                <BoundField
                  field={field}
                  id={id}
                  value={values[field.name] ?? ""}
                  onChange={setValue}
                  installedId={preview ? undefined : installedId}
                  widgetId={widget.id}
                />
              </div>
            </label>
          );
        })}
      </fieldset>
      {widget.action === "delete" ? (
        <label className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          I confirm that this record should be deleted.
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={
            disabled || submitting || (widget.action === "delete" && !confirmed)
          }
        >
          <Send size={14} />{" "}
          {submitting
            ? "Submitting…"
            : saved
              ? "Submit again"
              : ACTION_LABELS[widget.action ?? "create"]}
        </Button>
        {saved ? (
          <span
            role="status"
            className="text-xs font-medium text-emerald-700 dark:text-emerald-300"
          >
            {result?.completed
              ? "Completed successfully."
              : "Submitted. Your request was accepted. Record changes appear once processing completes."}
          </span>
        ) : null}
      </div>
      {result?.completed && widget.action === "execute" ? (
        <ActionResult result={result.result} />
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}

function ActionResult({ result }: { result: any }) {
  if (!result) return null;
  if (typeof result.imported === "number")
    return <div role="status" className="space-y-3 rounded-xl border border-dx-line bg-dx-subtle p-4 text-sm">
      <p className="font-semibold">Import results</p>
      <dl className="grid grid-cols-3 gap-4">{[["Imported", result.imported], ["Already present", result.skipped], ["Invalid rows", result.invalid]].map(([label, value]) =>
        <div key={label}><dt className="text-xs text-dx-muted">{label}</dt><dd className="mt-1 text-xl font-semibold">{value}</dd></div>)}</dl>
      {!!result.errors?.length && <div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs"><thead><tr><th className="py-2">Row</th><th>Correction needed</th></tr></thead><tbody>{result.errors.map((error: any, index: number) => <tr key={index}><td className="border-t border-dx-line py-2">{error.row}</td><td className="border-t border-dx-line py-2">{String(error.message)}</td></tr>)}</tbody></table></div>}
    </div>;
  if (typeof result.file_id === "string" && typeof result.rowCount === "number")
    return <div role="status" className="rounded-xl border border-dx-line bg-dx-subtle p-4 text-sm"><p className="font-semibold">{String(result.filename || "Report generated")}</p><p className="mt-1 text-dx-muted">{result.rowCount} rows · Select this report in the table to download it.</p></div>;
  if (typeof result.answer === "string")
    return (
      <div className="rounded-xl bg-dx-subtle p-5">
        <MarkdownView text={result.answer} />
        {result.citations?.length ? (
          <ol className="mt-4 space-y-1 text-xs text-dx-muted">
            {result.citations.map((citation: any, index: number) => (
              <li key={index}>
                [{index + 1}] {String(citation.title || citation.citation)}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    );
  if (typeof result.valid === "boolean")
    return (
      <div role="status" className="rounded-xl bg-dx-subtle p-4 text-sm">
        <p className="font-semibold">
          {result.valid ? "Form data is valid" : "Check the form data"}
        </p>
        {result.errors?.map((error: string, index: number) => (
          <p key={index} className="mt-2 text-rose-600">
            {error}
          </p>
        ))}
      </div>
    );
  if (Array.isArray(result.rows)) {
    const columns = Object.keys(result.rows[0] || {}).slice(0, 20);
    return (
      <div className="max-h-96 overflow-auto rounded-xl border border-dx-line">
        <table className="w-full text-left text-xs">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} className="bg-dx-subtle p-3">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.slice(0, 100).map((row: any, index: number) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column} className="border-t border-dx-line p-3">
                    {safeCellText(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="p-3 text-xs text-dx-muted">
          {result.total ?? result.rows.length} results · up to 100 shown
        </p>
      </div>
    );
  }
  return null;
}

function CollectionWidget({
  widget,
  data,
  loading,
  error,
  preview,
}: {
  widget: RuntimeWidget;
  data?: WidgetData;
  loading?: boolean;
  error?: string | null;
  preview?: boolean;
}) {
  if (preview)
    return (
      <div
        className="flex h-32 items-end gap-3 rounded-lg bg-dx-subtle p-4"
        aria-label="Layout preview"
      >
        {[40, 75, 55, 90, 60].map((height, index) => (
          <div
            key={index}
            className="flex-1 rounded-t-md bg-indigo-200 dark:bg-indigo-900"
            style={{ height: `${height}%` }}
          />
        ))}
        <span className="text-xs text-dx-muted">Preview</span>
      </div>
    );
  if (loading) return <Skeleton className="h-32 w-full" />;
  if (error) return <WidgetFeedback tone="bad" message={error} />;
  const columns = widget.columns ?? [];
  const rows = data?.rows ?? [];
  if (!rows.length)
    return (
      <EmptyState
        title="No data yet"
        message="This resource has no records to display."
      />
    );
  const numeric = rows.map((row) => Number(row[columns[1]]));
  const max = Math.max(1, ...numeric.filter(Number.isFinite).map(Math.abs));
  return (
    <div className="space-y-3">
      {rows.slice(0, 20).map((row, index) => (
        <div key={index} className="rounded-lg bg-dx-subtle px-3 py-2">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="truncate font-medium">
              {safeCellText(row[columns[0]])}
            </span>
            <span className="text-dx-muted">
              {safeCellText(row[columns[1]])}
            </span>
          </div>
          {widget.type === "chart" ? (
            <div className="mt-2 h-2 rounded-full bg-dx-line">
              <div
                className="h-2 rounded-full bg-indigo-500"
                style={{
                  width: `${Number.isFinite(numeric[index]) ? (Math.abs(numeric[index]) / max) * 100 : 0}%`,
                }}
              />
            </div>
          ) : (
            <p className="mt-1 truncate text-xs text-dx-muted">
              {columns
                .slice(2)
                .map((column) => safeCellText(row[column]))
                .join(" · ")}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function ActionButton({
  widget,
  preview,
}: {
  widget: RuntimeWidget;
  preview?: boolean;
}) {
  const actions = useContext(WorkspaceActions);
  return (
    <WidgetShell widget={widget}>
      <Button
        variant="primary"
        disabled={preview || !actions}
        onClick={() => {
          void actions?.run(widget.onClick!).catch(() => {});
        }}
      >
        {widget.title}
      </Button>
    </WidgetShell>
  );
}

export function SafeWidget({
  installedId,
  widget,
  data,
  dataLoading,
  dataError,
  preview,
  formUnavailableReason,
  onFormSubmit,
  formBusy,
}: SafeWidgetProps) {
  const pageActions = useContext(WorkspaceActions);
  const allowedPages = useContext(WorkspaceNavigation);
  const allowedModules = useContext(WorkspaceModules);
  const links = widget.links?.filter(
    (link) =>
      preview ||
      !allowedPages ||
      (link.target.startsWith("module:") &&
        (!allowedModules || allowedModules.includes(link.target.slice(7)))) ||
      link.target.startsWith("section:") ||
      (link.target.startsWith("page:") &&
        allowedPages.includes(link.target.slice(5))),
  );
  if (widget.type === "action") return null;
  if (widget.type === "button" && widget.onClick)
    return <ActionButton widget={widget} preview={preview} />;
  if (widget.type === "code")
    return (
      <WidgetShell widget={widget}>
        <p className="rounded-xl border border-dashed border-indigo-200 bg-indigo-50 p-6 text-sm text-indigo-700">
          Custom component · HTML / CSS / JavaScript
          <br />
          <span className="text-xs">
            Select this component and open Code Studio to edit and run it.
          </span>
        </p>
      </WidgetShell>
    );
  if (widget.type === "heading")
    return (
      <div className={cn("py-3", widget.width === "full" && "sm:col-span-2")}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-indigo-500">
          Workspace
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-dx-fg">
          {widget.title}
        </h2>
        {widget.text ? (
          <p className="mt-2 max-w-3xl text-sm leading-6 text-dx-muted">
            {widget.text}
          </p>
        ) : null}
      </div>
    );
  if (widget.type === "divider")
    return (
      <div
        className={cn(
          "flex items-center gap-3 py-4",
          widget.width === "full" && "sm:col-span-2",
        )}
      >
        <span className="text-xs font-semibold uppercase tracking-wider text-dx-muted">
          {widget.title}
        </span>
        <hr className="flex-1 border-dx-line" />
      </div>
    );
  if (widget.type === "capability")
    return (
      <WidgetFeedback message="Replace this legacy module with governed components in Studio." />
    );
  const navigation = ["navigation", "button", "tabs"].includes(widget.type);
  const activeSection =
    new URLSearchParams(window.location.search).get("section") ||
    new URLSearchParams(window.location.search).get("module") ||
    "tasks";
  return (
    <WidgetShell widget={widget}>
      {navigation ? (
        <nav
          aria-label={widget.title}
          className={cn(
            "flex flex-wrap gap-2",
            widget.type === "tabs" && "border-b border-dx-line pb-2",
          )}
        >
          {links?.map((link) => (
            <a
              key={link.target}
              href={preview || !link.actionId ? undefined : "#"}
              onClick={(e) => {
                e.preventDefault();
                if (!preview && link.actionId)
                  void pageActions?.run(link.actionId).catch(() => {});
              }}
              aria-disabled={preview || !link.actionId}
              aria-current={
                link.target === `section:${activeSection}` ? "page" : undefined
              }
              className={cn(
                "rounded-lg px-4 py-2 text-sm font-medium transition",
                link.target === `section:${activeSection}` &&
                  "ring-2 ring-teal-500 text-teal-700 dark:text-teal-300",
                widget.type === "button"
                  ? "bg-indigo-600 text-white hover:bg-indigo-500"
                  : "border border-dx-line bg-dx-subtle text-dx-fg hover:border-indigo-400",
              )}
            >
              {link.label}
            </a>
          ))}
        </nav>
      ) : null}
      {widget.type === "alert" ? (
        <div
          role="note"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {widget.text}
        </div>
      ) : null}
      {widget.type === "progress" ? (
        <div>
          <div className="mb-2 text-right text-2xl font-semibold tabular-nums">
            {widget.value ?? 0}%
          </div>
          <progress
            className="h-2 w-full overflow-hidden rounded-full accent-indigo-500"
            max={100}
            value={widget.value ?? 0}
            aria-label={widget.title}
          />
        </div>
      ) : null}
      {widget.type === "chart" ? (
        dataError ? (
          <WidgetFeedback tone="bad" message={dataError} />
        ) : dataLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <ChartWidget widget={widget} data={data} preview={preview} />
        )
      ) : null}
      {widget.type === "list" ? (
        <CollectionWidget
          widget={widget}
          data={data}
          loading={dataLoading}
          error={dataError}
          preview={preview}
        />
      ) : null}
      {widget.type === "markdown" ? (
        <MarkdownView text={widget.text || ""} />
      ) : null}
      {widget.type === "kanban" ? (
        dataError ? (
          <WidgetFeedback tone="bad" message={dataError} />
        ) : dataLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <KanbanView widget={widget} data={data} />
        )
      ) : null}
      {widget.type === "timeline" ? (
        dataError ? (
          <WidgetFeedback tone="bad" message={dataError} />
        ) : dataLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <TimelineView widget={widget} data={data} />
        )
      ) : null}
      {widget.type === "text" ? <TextWidget widget={widget} /> : null}
      {widget.type === "metric" ? (
        <MetricWidget
          widget={widget}
          data={data}
          loading={dataLoading}
          error={dataError}
          preview={preview}
        />
      ) : null}
      {widget.type === "map" ? (
        dataLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : dataError ? (
          <WidgetFeedback tone="bad" message={dataError} />
        ) : (
          <MapWidget widget={widget} data={data} preview={preview} />
        )
      ) : null}
      {widget.type === "table" ? (
        <RecordTable
          widget={widget}
          data={data}
          loading={dataLoading}
          error={dataError}
          preview={preview}
        />
      ) : null}
      {widget.type === "form" ? (
        <FormWidget
          widget={widget}
          preview={preview}
          unavailableReason={formUnavailableReason}
          onSubmit={onFormSubmit}
          busy={formBusy}
          installedId={installedId}
        />
      ) : null}
    </WidgetShell>
  );
}
