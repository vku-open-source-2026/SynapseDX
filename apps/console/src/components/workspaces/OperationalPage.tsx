import { WorkspaceActions, WorkspaceActionProvider } from "./WorkspaceActions";
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import {
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ClipboardList,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import { api } from "../../lib/api";
import {
  safeCellText,
  type InstalledPlugin,
  type RuntimeWidget,
} from "../../lib/workspaces";
import { MarkdownView } from "./CollectionViews";
import { Modal } from "../Modal";
import { Button } from "../ui";
import { RuntimeWidgetCard } from "./RuntimeWidgetCard";
import { RecordSelection, type SelectedRecord } from "./RecordSelection";
import { WorkspaceModules } from "./WorkspaceNavigation";
import { fieldLabel } from "./RecordTable";

export function OperationalPage({
  plugin,
  cacheScope,
  modules,
  section,
}: {
  plugin: InstalledPlugin;
  cacheScope: string;
  modules: string[];
  section?: string;
}) {
  const [selected, setSelected] = useState<SelectedRecord | null>(null),
    [details, setDetails] = useState(false),
    [action, setAction] = useState<RuntimeWidget | null>(null),
    [actionsOpen, setActionsOpen] = useState(false);
  const select = useCallback(
    (resource: string, row: Record<string, unknown>, origin?: { widgetId: string; actionId: string }) => {
      setSelected({ resource, row, ...origin });
      setDetails(true);
    },
    [],
  );
  const source = plugin.widgets.find(
    (widget) =>
      widget.id === selected?.widgetId && widget.resource === selected?.resource &&
      ["table", "list", "map", "kanban", "timeline"].includes(widget.type),
  );
  const detail = useQuery({
    queryKey: [
      "workspace-record",
      cacheScope,
      plugin.id,
      source?.id,
      selected?.actionId,
      selected?.row.id,
    ],
    enabled: !!selected && !!source && details,
    retry: false,
    queryFn: () =>
      api.get<{ data: Record<string, unknown>; version: number }>(
        `/v1/capabilities/workspaces/installed/${encodeURIComponent(plugin.id)}/widgets/${encodeURIComponent(source!.id)}/records/${encodeURIComponent(String(selected!.row.id))}?action=${encodeURIComponent(selected!.actionId || "")}`,
      ),
  });
  const current = useMemo<SelectedRecord | null>(
    () =>
      selected
        ? {
            ...selected,
            row: { ...selected.row, ...detail.data?.data, id: selected.row.id },
          }
        : null,
    [selected, detail.data],
  );
  const active =
    section || plugin.widgets.find((widget) => widget.section)?.section;
  const visible = plugin.widgets.filter(
    (widget) => !widget.section || widget.section === active,
  );
  useEffect(() => {
    setSelected(null);
    setDetails(false);
    setAction(null);
  }, [plugin.id, active]);
  const forms = visible.filter(
    (widget) => widget.type === "form" && widget.presentation !== "inline",
  );
  const content = visible.filter(
    (widget) =>
      widget.type !== "action" &&
      (widget.type !== "form" || widget.presentation === "inline") &&
      !(widget.type === "heading" && !widget.section),
  );
  const heading = visible.find((widget) => widget.type === "heading");
  const recordActions = visible
    .filter((widget) => widget.type === "form")
    .filter(
      (widget) =>
        widget.resource === selected?.resource && widget.action !== "create",
    );
  const openAction = (widget: RuntimeWidget) => {
    setAction(widget);
    setActionsOpen(false);
    setDetails(false);
  };
  const render = (widget: RuntimeWidget) => (
    <RuntimeWidgetCard
      key={widget.id}
      installedId={plugin.id}
      widgets={plugin.widgets}
      product={plugin.product}
      widget={widget}
      cacheScope={cacheScope}
    />
  );
  return (
    <WorkspaceModules.Provider value={modules}>
      <RecordSelection.Provider value={{ selected: current, select }}>
        <WorkspaceActionProvider
          key={plugin.id + active}
          installedId={plugin.id}
          widgets={plugin.widgets}
          cacheScope={cacheScope}
          product={plugin.product}
          openForm={openAction}
        >
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[.16em] text-teal-600">
                {plugin.product === "sos"
                  ? "Emergency operations"
                  : "Infrastructure operations"}
              </p>
              <h1 className="mt-2 text-[28px] font-semibold tracking-tight sm:text-3xl">
                {plugin.name}
              </h1>
              {heading?.text ? (
                <p className="mt-2 max-w-3xl text-sm leading-6 text-dx-muted">
                  {heading.text}
                </p>
              ) : null}
            </div>
            <div className="flex gap-2">
              {forms.some((widget) => widget.action === "create") ? (
                <RegisteredOpenButton
                  widgets={plugin.widgets}
                  widget={forms.find((w) => w.action === "create")!}
                  onBefore={() => setSelected(null)}
                  variant="primary"
                >
                  <Plus size={15} />
                  New record
                </RegisteredOpenButton>
              ) : null}
              {forms.length ? (
                <button
                  type="button"
                  onClick={() => setActionsOpen(true)}
                  className="flex items-center gap-2 rounded-lg border border-dx-line bg-dx-surface px-3.5 py-2 text-xs font-medium"
                >
                  <SlidersHorizontal size={14} />
                  Actions
                </button>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-12 gap-5">
            {content.map((widget) => (
              <div
                key={widget.id}
                className={
                  widget.width === "quarter"
                    ? "col-span-12 sm:col-span-6 xl:col-span-3"
                    : widget.width === "third"
                      ? "col-span-12 lg:col-span-4"
                      : widget.width === "half"
                        ? "col-span-12 lg:col-span-6"
                        : "col-span-12"
                }
              >
                {render(widget)}
              </div>
            ))}
          </div>
          <Modal
            open={actionsOpen}
            onClose={() => setActionsOpen(false)}
            title="Available actions"
            eyebrow={plugin.name}
          >
            <div className="space-y-2">
              {forms.map((widget) => (
                <RegisteredOpenButton
                  widgets={plugin.widgets}
                  widget={widget}
                  key={widget.id}
                  className="flex w-full items-center gap-3 rounded-xl border border-dx-line p-4 text-left hover:bg-dx-subtle"
                >
                  <ClipboardList size={18} className="text-teal-600" />
                  <span className="flex-1">
                    <span className="block text-sm font-medium">
                      {widget.title}
                    </span>
                    <span className="mt-1 block text-xs text-dx-muted">
                      {fieldLabel(widget.resource || "Action")}
                    </span>
                  </span>
                  <ArrowRight size={14} />
                </RegisteredOpenButton>
              ))}
            </div>
          </Modal>
          <Modal
            open={!!action}
            onClose={() => setAction(null)}
            title={action?.title || "Action"}
            eyebrow={plugin.name}
          >
            {action ? render(action) : null}
          </Modal>
          <Modal
            open={details}
            onClose={() => setDetails(false)}
            title={safeCellText(
              current?.row.name ?? current?.row.title ?? current?.row.id,
            )}
            eyebrow={fieldLabel(selected?.resource || "Record")}
            wide
            footer={
              recordActions.length ? (
                <div className="flex flex-wrap gap-2">
                  {recordActions.map((widget) => (
                    <RegisteredOpenButton
                      widgets={plugin.widgets}
                      widget={widget}
                      key={widget.id}
                      variant={widget.action === "delete" ? "ghost" : "primary"}
                    >
                      {widget.title}
                    </RegisteredOpenButton>
                  ))}
                </div>
              ) : undefined
            }
          >
            {detail.isError ? (
              <p role="alert" className="mb-4 text-xs text-rose-600">
                The full record could not be loaded. {detail.error.message}
              </p>
            ) : null}
            <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              {Object.entries(current?.row || {}).map(([key, value]) => (
                <div
                  key={key}
                  className={
                    value && typeof value === "object" ? "sm:col-span-2" : ""
                  }
                >
                  <dt className="text-[10px] font-medium uppercase tracking-wider text-dx-muted">
                    {fieldLabel(key)}
                  </dt>
                  <dd className="mt-1.5 break-words whitespace-pre-wrap text-sm">
                    {key === "markdown" && typeof value === "string" ? (
                      <MarkdownView text={value} />
                    ) : value && typeof value === "object" ? (
                      <pre className="max-h-56 overflow-auto rounded-xl bg-dx-subtle p-4 text-xs leading-6">
                        {JSON.stringify(value, null, 2)}
                      </pre>
                    ) : (
                      safeCellText(value, 10000)
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </Modal>
        </WorkspaceActionProvider>
      </RecordSelection.Provider>
    </WorkspaceModules.Provider>
  );
}

function RegisteredOpenButton({
  widgets,
  widget,
  onBefore,
  children,
  variant,
  className,
}: {
  widgets: RuntimeWidget[];
  widget: RuntimeWidget;
  onBefore?: () => void;
  children: ReactNode;
  variant?: "ghost" | "primary";
  className?: string;
}) {
  const actions = useContext(WorkspaceActions),
    open = widgets.find(
      (w) =>
        w.type === "action" &&
        w.operation?.kind === "openForm" &&
        w.operation.target === widget.id,
    );
  return (
    <Button
      className={className}
      variant={variant}
      disabled={!open}
      onClick={() => {
        onBefore?.();
        if (open) void actions?.run(open.id).catch(() => {});
      }}
    >
      {children}
    </Button>
  );
}
