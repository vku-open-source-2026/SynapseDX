import {
  ACTION_EVENTS,
  ACTION_DATA_TYPES,
  actionGovernanceErrors,
  materializeActions,
} from "../../../lib/studioActions";
import { createPortal } from "react-dom";
import { STARTER_ACTION } from "../../../lib/studioActionRuntime";
const ActionEditor = lazy(() =>
  import("./ActionEditor").then((m) => ({ default: m.ActionEditor })),
);
import { lazy, Suspense } from "react";
import { STARTER_CODE } from "../../../lib/studioCode";
const CodeStudio = lazy(() =>
  import("./CodeStudio").then((module) => ({ default: module.CodeStudio })),
);
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Visual low-code plugin builder. Everything is declarative: widgets are added
 * from a fixed safe palette, reordered, configured against catalog keys, and
 * previewed. No JSON editor is required and no schema value is ever executed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  History,
  Download,
  FileJson,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import {
  Button,
  Card,
  Field,
  EmptyState,
  SmallButton,
  inputClassName,
  selectClassName,
} from "../../../components/ui";
import { Modal, ModalError } from "../../../components/Modal";
import {
  VisualDesigner,
  COMPONENTS,
} from "../../../components/workspaces/VisualDesigner";
import { MODULE_CATALOG } from "../../../components/workspaces/CapabilityModule";
import { commonTemplateForSection } from "../../../lib/commonTemplate";
import { SafeWidget } from "../../../components/workspaces/SafeWidget";
import { toast } from "../../../stores/toastStore";
import { relativeTime } from "../../../lib/format";
import {
  CAPABILITY_MODULES,
  DATA_WIDGETS,
  FIELD_TYPES,
  NAV_WIDGETS,
  TEXT_WIDGETS,
  canAddWidget,
  catalogActionTypes,
  catalogMutation,
  catalogResources,
  catalogRoles,
  catalogUnavailableActions,
  catalogWidgetTypes,
  exportBundleFileName,
  isSafeWorkflowArtifactId,
  moveItem,
  nextWidgetId,
  parsePluginBundle,
  slugify,
  toWriteWidget,
  validatePluginDraft,
  validateWidget,
  type PluginBundle,
  type PluginRevisionSummary,
  type ValidationIssue,
  type WorkspaceCatalog,
  type WorkspaceField,
  type WorkspaceFormAction,
  type WorkspaceOrgReadiness,
  type WorkspacePlugin,
  type WorkspaceProduct,
  type WorkspaceWidget,
  type WorkspaceWidgetType,
} from "../../../lib/workspaces";
import {
  buildPluginBundle,
  createPlugin,
  exportPluginBundle,
  fetchPluginRevisions,
  fetchWorkflowArtifacts,
  importPluginBundle,
  publishPlugin,
  restorePluginRevision,
  unpublishPlugin,
  updatePlugin,
} from "../../../lib/workspacesApi";
import type { WorkflowArtifactSummary } from "../../../lib/workspaces";

interface BuilderPanelProps {
  requestedPluginId?: string;
  onSelected?: (id: string) => void;
  product: WorkspaceProduct;
  catalog: WorkspaceCatalog | null;
  plugins: WorkspacePlugin[];
  loading: boolean;
  onChanged: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

interface BuildArtifact {
  pluginName: string;
  version: number;
  repository: string;
  path: string;
  checksum: string;
  filename: string;
}

const WIDGET_LABELS = Object.fromEntries(
  COMPONENTS.map((item) => [item.type, item.label]),
) as Record<WorkspaceWidgetType, string>;

function clonePlugin(plugin: WorkspacePlugin): WorkspacePlugin {
  return JSON.parse(JSON.stringify(plugin)) as WorkspacePlugin;
}

function snapshotOf(plugin: WorkspacePlugin): string {
  return JSON.stringify({
    name: plugin.name,
    slug: plugin.slug,
    audience: plugin.audience,
    roles: plugin.roles,
    widgets: plugin.widgets,
  });
}

function errorText(error: unknown): string {
  const value = error as { message?: string; code?: string };
  const message =
    value?.message || "The capability service refused the request.";
  return value?.code ? `${message} (${value.code})` : message;
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function defaultWidget(
  type: WorkspaceWidgetType,
  existing: string[],
  resources: string[],
): WorkspaceWidget {
  const widget: WorkspaceWidget = {
    id: nextWidgetId(type, existing),
    type,
    title: `New ${WIDGET_LABELS[type].toLowerCase()}`,
    width: "half",
  };
  if (TEXT_WIDGETS.includes(type)) widget.text = "";
  if (NAV_WIDGETS.includes(type))
    widget.links = [{ label: "Tasks", target: "module:tasks" }];
  if (type === "capability") {
    widget.module = "tasks";
    widget.width = "full";
  }
  if (type === "action") widget.operation = structuredClone(STARTER_ACTION);
  if (type === "code") {
    widget.code = structuredClone(STARTER_CODE);
    widget.width = "full";
  }
  if (type === "progress") widget.value = 50;
  if (type === "heading" || type === "divider" || NAV_WIDGETS.includes(type))
    widget.width = "full";
  if (DATA_WIDGETS.includes(type)) {
    if (resources[0]) widget.resource = resources[0];
  }
  if (["table", "chart", "list", "map", "kanban", "timeline"].includes(type))
    widget.columns = type === "chart" ? ["name", "value"] : ["id"];
  if (type === "kanban") {
    widget.width = "full";
    widget.columns = ["title", "status", "assignee"];
    widget.groupBy = "status";
    widget.groups = ["todo", "doing", "done"];
  }
  if (type === "timeline") {
    widget.width = "full";
    widget.columns = ["title", "createdAt"];
  }
  if (type === "map") {
    widget.width = "full";
    widget.columns = [
      "id",
      "name",
      "title",
      "status",
      "latitude",
      "longitude",
      "geometry",
      "location",
      "current_location",
    ];
  }
  if (type === "form") {
    widget.action = "create";
    widget.fields = [{ name: "notes", label: "Notes", type: "textarea" }];
  }
  return widget;
}

function Issues({
  issues,
  max = 8,
}: {
  issues: ValidationIssue[];
  max?: number;
}) {
  if (issues.length === 0) return null;
  return (
    <ul
      role="alert"
      className="space-y-1 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
    >
      {issues.slice(0, max).map((issue, index) => (
        <li key={`${issue.path}-${index}`}>
          {issue.path ? <span className="font-mono">{issue.path}</span> : null}
          {issue.path ? ": " : ""}
          {issue.message}
        </li>
      ))}
      {issues.length > max ? (
        <li>…and {issues.length - max} more issue(s).</li>
      ) : null}
    </ul>
  );
}

function WidgetEditor({
  widget,
  widgets,
  index,
  resources,
  artifacts,
  artifactsError,
  formExecutionReady,
  formExecutionRequirement,
  actions,
  orgReadiness,
  unavailableActions,
  onChange,
}: {
  widget: WorkspaceWidget;
  widgets: WorkspaceWidget[];
  index: number;
  resources: string[];
  artifacts: WorkflowArtifactSummary[];
  artifactsError: string | null;
  formExecutionReady: boolean;
  formExecutionRequirement?: string;
  actions: WorkspaceFormAction[];
  orgReadiness?: WorkspaceOrgReadiness;
  /** Catalog-declared capability actions this deployment cannot execute. */
  unavailableActions: WorkspaceFormAction[];
  onChange: (patch: Partial<WorkspaceWidget>) => void;
}) {
  const [columnsText, setColumnsText] = useState(
    (widget.columns ?? []).join(", "),
  );

  useEffect(() => {
    setColumnsText((widget.columns ?? []).join(", "));
  }, [widget.id]);

  const issues = validateWidget(widget, index);
  const boundArtifact = widget.workflowArtifactId
    ? artifacts.find((artifact) => artifact.id === widget.workflowArtifactId)
    : undefined;

  const updateField = (fieldIndex: number, patch: Partial<WorkspaceField>) => {
    const fields = (widget.fields ?? []).map((field, current) =>
      current === fieldIndex ? { ...field, ...patch } : field,
    );
    onChange({ fields });
  };

  if (widget.type === "action")
    return (
      <Suspense fallback={<p>Loading action editor…</p>}>
        <ActionEditor widget={widget} widgets={widgets} onChange={onChange} />
      </Suspense>
    );

  return (
    <div className="space-y-3">
      <div className="grid gap-3">
        <Field label="Widget title" required>
          <input
            className={inputClassName}
            value={widget.title}
            maxLength={200}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </Field>
        <Field label="Width">
          <select
            className={selectClassName}
            value={widget.width ?? "half"}
            onChange={(event) =>
              onChange({
                width: event.target.value as WorkspaceWidget["width"],
              })
            }
          >
            <option value="half">Half</option>
            <option value="full">Full</option>
            <option value="third">Third</option>
            <option value="quarter">Quarter</option>
          </select>
        </Field>
      </div>

      <Field
        label="Section"
        help="Widgets with the same section id appear together. Leave blank to appear in every section."
      >
        <input
          aria-label="Widget section"
          className={inputClassName}
          value={widget.section || ""}
          placeholder="tasks"
          onChange={(event) =>
            onChange({ section: event.target.value || undefined })
          }
        />
      </Field>
      {widget.type === "form" ? (
        <Field label="Form display">
          <select
            className={selectClassName}
            value={widget.presentation || "dialog"}
            onChange={(event) =>
              onChange({
                presentation: event.target.value as "inline" | "dialog",
              })
            }
          >
            <option value="dialog">Action dialog</option>
            <option value="inline">Inline on page</option>
          </select>
        </Field>
      ) : null}
      {widget.type === "kanban" ? (
        <>
          <Field label="Group field">
            <input
              className={inputClassName}
              value={widget.groupBy || ""}
              onChange={(event) =>
                onChange({ groupBy: event.target.value || undefined })
              }
            />
          </Field>
          <Field
            label="Group values"
            help="Comma-separated status values in display order."
          >
            <input
              className={inputClassName}
              value={widget.groups?.join(", ") || ""}
              onChange={(event) =>
                onChange({
                  groups: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field
            label="Update form id"
            help="Dragging submits this page’s authorized update form. It must declare record_id and the group field."
          >
            <input
              className={inputClassName}
              value={widget.updateForm || ""}
              onChange={(event) =>
                onChange({ updateForm: event.target.value || undefined })
              }
            />
          </Field>
        </>
      ) : null}
      {TEXT_WIDGETS.includes(widget.type) ? (
        <Field
          label="Plain text"
          help="No HTML, JavaScript, eval or URLs. Line breaks are preserved."
        >
          <textarea
            className={`${inputClassName} min-h-[120px]`}
            value={widget.text ?? ""}
            maxLength={4000}
            onChange={(event) => onChange({ text: event.target.value })}
          />
        </Field>
      ) : null}

      {[
        "metric",
        "table",
        "chart",
        "list",
        "map",
        "kanban",
        "timeline",
      ].includes(widget.type) ? (
        <Field
          label="Catalog resource"
          required
          help="Only resource keys are stored. The browser never receives a product URL or dataset id."
        >
          <select
            className={selectClassName}
            value={widget.resource ?? ""}
            onChange={(event) =>
              onChange({
                resource: event.target.value || undefined,
                ...(event.target.value.startsWith("common")
                  ? { workflowArtifactId: undefined }
                  : {}),
              })
            }
          >
            <option value="">Choose a resource</option>
            {resources.map((resource) => (
              <option key={resource} value={resource}>
                {resource}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {["table", "chart", "list", "map", "kanban", "timeline"].includes(
        widget.type,
      ) ? (
        <Field
          label="Columns"
          help="Comma-separated field names. Leave empty to use columns returned by the capability service."
        >
          <input
            className={inputClassName}
            value={columnsText}
            placeholder="id, status, updatedAt"
            onChange={(event) => {
              const next = event.target.value;
              setColumnsText(next);
              const columns = next
                .split(",")
                .map((column) => column.trim())
                .filter(Boolean);
              onChange({ columns });
            }}
          />
        </Field>
      ) : null}

      {widget.type !== "code" && (
        <div className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/30 p-3">
          <p className="text-xs font-semibold">Declared widget events</p>
          {ACTION_EVENTS.filter((event) =>
            event === "onLoad"
              ? ACTION_DATA_TYPES.includes(widget.type)
              : event === "onSubmit"
                ? widget.type === "form"
                : event === "onClick"
                  ? widget.type === "button"
                  : event === "onChange"
                    ? widget.type === "kanban"
                    : ["table", "list", "map", "kanban", "timeline"].includes(
                        widget.type,
                      ),
          ).map((event) => (
            <Field key={event} label={event}>
              <select
                aria-label={`Widget ${event}`}
                className={selectClassName}
                value={widget[event] || ""}
                onChange={(e) =>
                  onChange({
                    [event]: e.target.value || undefined,
                    ...(event === "onClick" && e.target.value
                      ? { links: undefined }
                      : {}),
                  })
                }
              >
                <option value="">Disabled · choose an action</option>
                {widgets
                  .filter(
                    (w) =>
                      w.type === "action" &&
                      (event === "onLoad"
                        ? (w.operation?.kind === "query" &&
                            w.operation.target === widget.id) ||
                          (w.operation?.kind === "function" &&
                            w.operation.inputs.includes(widget.id) &&
                            !w.operation.actions.length)
                        : event === "onSubmit"
                          ? w.operation?.target === widget.id &&
                            w.operation.kind === (widget.action || "create")
                          : event === "onChange"
                            ? w.operation?.kind === "update" &&
                              w.operation.target === widget.updateForm
                            : event === "onRowClick"
                              ? w.operation?.kind === "showRecord" &&
                                w.operation.target === widget.id
                              : event === "onExport"
                                ? w.operation?.kind === "export" &&
                                  w.operation.target === widget.id
                                : true),
                  )
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.title} · {w.operation?.kind}
                    </option>
                  ))}
              </select>
            </Field>
          ))}
          <p className="text-[10px] text-dx-muted">
            Create actions in the Actions panel first. Unassigned events cannot
            execute.
          </p>
        </div>
      )}
      {widget.type === "chart" && (
        <>
          <Field label="Chart type">
            <select
              className={selectClassName}
              value={widget.chartType || "bar"}
              onChange={(e) =>
                onChange({
                  chartType: e.target.value as WorkspaceWidget["chartType"],
                })
              }
            >
              {["bar", "line", "area", "pie", "donut"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field
            label="Aggregate loaded records"
            help="First column is the category. Other columns are numeric series. Aggregation applies to the loaded query page."
          >
            <select
              className={selectClassName}
              value={widget.aggregation || "none"}
              onChange={(e) =>
                onChange({
                  aggregation: e.target.value as WorkspaceWidget["aggregation"],
                })
              }
            >
              {["none", "count", "sum", "average"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
        </>
      )}
      {widget.type === "code" ? (
        <Suspense fallback={<p>Loading code editor…</p>}>
          <CodeStudio
            key={widget.id}
            widget={widget}
            widgets={widgets}
            onChange={onChange}
          />
        </Suspense>
      ) : null}
      {widget.type === "capability" ? (
        <Field label="H-D-P-I capability">
          <select
            className={selectClassName}
            value={widget.module ?? "tasks"}
            onChange={(event) => onChange({ module: event.target.value })}
          >
            {MODULE_CATALOG.map((item) => (
              <option key={item.id} value={item.id}>
                {item.lane} · {item.label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {widget.type === "progress" ? (
        <Field label="Progress (%)">
          <input
            className={inputClassName}
            type="number"
            min={0}
            max={100}
            value={widget.value ?? 0}
            onChange={(event) =>
              onChange({ value: Number(event.target.value) })
            }
          />
        </Field>
      ) : null}
      {NAV_WIDGETS.includes(widget.type) && !widget.onClick ? (
        <div className="space-y-3">
          <p className="text-xs text-dx-muted">
            Link to a section, page slug or capability module.
          </p>
          {(widget.links ?? []).map((link, index) => (
            <div
              key={index}
              className="space-y-2 rounded-lg border border-dx-line p-2"
            >
              <input
                aria-label={`Link ${index + 1} label`}
                className={inputClassName}
                maxLength={80}
                value={link.label}
                onChange={(event) =>
                  onChange({
                    links: widget.links?.map((item, i) =>
                      i === index
                        ? { ...item, label: event.target.value }
                        : item,
                    ),
                  })
                }
              />
              <input
                aria-label={`Link ${index + 1} destination`}
                className={inputClassName}
                value={link.target}
                placeholder="section:tasks or page:my-page"
                onChange={(event) =>
                  onChange({
                    links: widget.links?.map((item, i) =>
                      i === index
                        ? { ...item, target: event.target.value }
                        : item,
                    ),
                  })
                }
              />
              <select
                aria-label={`Choose capability for link ${index + 1}`}
                className={selectClassName}
                value={
                  link.target.startsWith("module:") ? link.target.slice(7) : ""
                }
                onChange={(event) => {
                  if (event.target.value)
                    onChange({
                      links: widget.links?.map((item, i) =>
                        i === index
                          ? { ...item, target: `module:${event.target.value}` }
                          : item,
                      ),
                    });
                }}
              >
                <option value="">Choose capability…</option>
                {MODULE_CATALOG.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              <Field label="Navigation action">
                <select
                  aria-label={`Link ${index + 1} action`}
                  className={selectClassName}
                  value={link.actionId || ""}
                  onChange={(e) =>
                    onChange({
                      links: widget.links?.map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              actionId: e.target.value || undefined,
                              target:
                                widgets.find((w) => w.id === e.target.value)
                                  ?.operation?.destination || item.target,
                            }
                          : item,
                      ),
                    })
                  }
                >
                  <option value="">Choose a created action</option>
                  {widgets
                    .filter(
                      (w) =>
                        w.type === "action" && w.operation?.kind === "navigate",
                    )
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.title} · {w.operation?.destination}
                      </option>
                    ))}
                </select>
              </Field>
              <SmallButton
                type="button"
                onClick={() =>
                  onChange({
                    links: widget.links?.filter((_, i) => i !== index),
                  })
                }
              >
                Remove link
              </SmallButton>
            </div>
          ))}
          <Button
            variant="ghost"
            disabled={(widget.links?.length ?? 0) >= 12}
            onClick={() =>
              onChange({
                links: [
                  ...(widget.links ?? []),
                  { label: "New link", target: "module:tasks" },
                ],
              })
            }
          >
            <Plus size={14} /> Add link
          </Button>
        </div>
      ) : null}

      {widget.type === "form" ? (
        <div className="space-y-3">
          {!widget.resource?.startsWith("common") &&
          (!formExecutionReady || (orgReadiness && !orgReadiness.ready)) ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
              <p className="font-semibold">
                Form execution is currently unavailable.
              </p>
              {!formExecutionReady ? (
                <p>
                  {formExecutionRequirement ||
                    "The capability service reports the global execution gate is closed."}
                </p>
              ) : null}
              {orgReadiness && !orgReadiness.ready ? (
                <p>
                  {orgReadiness.requirement}
                  {orgReadiness.reason ? ` (${orgReadiness.reason})` : ""}
                </p>
              ) : null}
            </div>
          ) : null}
          <Field
            label="Declared action"
            help="The bound workflow performs the operation. The action is declarative metadata for the product workflow."
          >
            <select
              className={selectClassName}
              value={widget.action ?? "create"}
              onChange={(event) =>
                onChange({
                  action: event.target.value as WorkspaceWidget["action"],
                })
              }
            >
              {actions.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Catalog resource" required>
            <select
              className={selectClassName}
              value={widget.resource ?? ""}
              onChange={(event) =>
                onChange({
                  resource: event.target.value || undefined,
                  ...(event.target.value.startsWith("common")
                    ? { workflowArtifactId: undefined }
                    : {}),
                })
              }
            >
              <option value="">Choose a resource</option>
              {resources.map((resource) => (
                <option key={resource} value={resource}>
                  {resource}
                </option>
              ))}
            </select>
          </Field>

          {widget.resource?.startsWith("common") ? (
            <>
              <p className="rounded-lg bg-teal-50 p-3 text-xs leading-5 text-teal-800 dark:bg-teal-950 dark:text-teal-200">
                Bound to the Common capability. Actions use the member’s app
                permissions.
              </p>
              {unavailableActions.includes(
                (widget.action ?? "create") as WorkspaceFormAction,
              ) ? (
                <div
                  role="note"
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300"
                >
                  <p className="font-semibold">
                    This action is unavailable on this deployment.
                  </p>
                  <p>
                    The bound capability operation needs the agent runtime,
                    which is not configured here. The published form stays
                    read-only and submits are refused with reason{" "}
                    <span className="font-mono">capability_unavailable</span>{" "}
                    until a real runtime is configured.
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <Field
                label="Bound workflow artifact"
                help="Form values are sent only to this same-organization workflow. Unbound forms stay read-only in the member workspace."
              >
                <select
                  className={selectClassName}
                  value={widget.workflowArtifactId ?? ""}
                  onChange={(event) =>
                    onChange({
                      workflowArtifactId: event.target.value || undefined,
                    })
                  }
                >
                  <option value="">Unbound (read-only)</option>
                  {widget.workflowArtifactId && !boundArtifact ? (
                    <option value={widget.workflowArtifactId}>
                      {widget.workflowArtifactId} (not in the current list)
                    </option>
                  ) : null}
                  {artifacts.map((artifact) => (
                    <option key={artifact.id} value={artifact.id}>
                      {artifact.name}
                      {artifact.active ? "" : " (inactive)"}
                      {artifact.syncState && artifact.syncState !== "ready"
                        ? ` (${artifact.syncState})`
                        : ""}{" "}
                      · {artifact.id}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Artifact id"
                help="Selection or direct input. The capability service verifies same-organization ownership before execution."
              >
                <input
                  className={inputClassName}
                  value={widget.workflowArtifactId ?? ""}
                  placeholder="artifact id"
                  onChange={(event) =>
                    onChange({
                      workflowArtifactId: event.target.value || undefined,
                    })
                  }
                />
              </Field>

              {artifactsError ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
                  Workflow artifacts could not be listed: {artifactsError}. You
                  can paste an artifact id; execution stays server-validated.
                </p>
              ) : null}
              {boundArtifact && !boundArtifact.active ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
                  This artifact is inactive. Execution may be refused by the
                  workflow capability.
                </p>
              ) : null}
              {boundArtifact &&
              boundArtifact.syncState &&
              boundArtifact.syncState !== "ready" ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
                  This artifact sync state is{" "}
                  <span className="font-mono">{boundArtifact.syncState}</span>.
                  Reconcile it in{" "}
                  <a
                    className="font-semibold underline underline-offset-2"
                    href="/admin/workflows"
                  >
                    Workflows
                  </a>{" "}
                  before publishing or execution.
                </p>
              ) : null}
              {widget.workflowArtifactId &&
              !isSafeWorkflowArtifactId(widget.workflowArtifactId) ? (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
                  Artifact id must be 8–120 letters, digits, underscores or
                  hyphens.
                </p>
              ) : null}
            </>
          )}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                Declared fields
              </p>
              <SmallButton
                type="button"
                onClick={() =>
                  onChange({
                    fields: [
                      ...(widget.fields ?? []),
                      {
                        name: `field${(widget.fields?.length ?? 0) + 1}`,
                        label: "New field",
                        type: "text",
                      },
                    ],
                  })
                }
                disabled={(widget.fields?.length ?? 0) >= 30}
              >
                <Plus size={13} /> Add field
              </SmallButton>
            </div>
            <div className="space-y-2">
              {(widget.fields ?? []).map((field, fieldIndex) => (
                <div
                  key={fieldIndex}
                  className="grid gap-2 rounded-xl border border-slate-200 p-2 dark:border-[#26354d] sm:grid-cols-[1fr_1fr_110px_70px_34px]"
                >
                  <input
                    className={`${inputClassName} py-1.5 text-xs`}
                    value={field.name}
                    placeholder="name"
                    maxLength={64}
                    onChange={(event) =>
                      updateField(fieldIndex, { name: event.target.value })
                    }
                  />
                  <input
                    className={`${inputClassName} py-1.5 text-xs`}
                    value={field.label}
                    placeholder="Label"
                    maxLength={200}
                    onChange={(event) =>
                      updateField(fieldIndex, { label: event.target.value })
                    }
                  />
                  <select
                    className={`${selectClassName} py-1.5 text-xs`}
                    value={field.type}
                    onChange={(event) =>
                      updateField(fieldIndex, {
                        type: event.target.value as WorkspaceField["type"],
                        ...(event.target.value !== "json" ? { editor: undefined } : {}),
                        ...(event.target.value !== "file" ? { uploadAction: undefined, accept: undefined, maxBytes: undefined } : { defaultValue: undefined }),
                        ...(event.target.value !== "select"
                          ? { options: undefined, optionsResource: undefined }
                          : {}),
                      })
                    }
                  >
                    {FIELD_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={field.required === true}
                      onChange={(event) =>
                        updateField(fieldIndex, {
                          required: event.target.checked,
                        })
                      }
                    />
                    Req.
                  </label>
                  <SmallButton
                    type="button"
                    variant="danger"
                    aria-label={`Remove field ${field.label}`}
                    onClick={() =>
                      onChange({
                        fields: (widget.fields ?? []).filter(
                          (_, current) => current !== fieldIndex,
                        ),
                      })
                    }
                  >
                    <Trash2 size={13} />
                  </SmallButton>
                  <div className="space-y-2 sm:col-span-5">
                    <label className="block text-xs text-dx-muted">Selected record field<input aria-label={`Selected record field for ${field.label}`} className={inputClassName + " mt-1"} placeholder={field.name} value={field.selectionPath || ""} onChange={e => updateField(fieldIndex, { selectionPath: e.target.value || undefined })} /></label>
                    {field.type === "json" && <label className="block text-xs text-dx-muted">Editor
                      <select aria-label={`Editor for ${field.label}`} className={selectClassName + " mt-1"} value={field.editor || "json"} onChange={e => updateField(fieldIndex, { editor: e.target.value as WorkspaceField["editor"] })}>
                        <option value="json">JSON</option><option value="schema">Form schema designer</option><option value="query">Report query builder</option><option value="geometry">Map geometry editor</option>
                      </select></label>}
                    {field.type === "file" && <>
                      <select aria-label={`Upload action for ${field.label}`} className={selectClassName} value={field.uploadAction || ""} onChange={e => updateField(fieldIndex, { uploadAction: e.target.value || undefined })}>
                        <option value="">Choose upload action</option>{widgets.filter(w => w.type === "action" && w.operation?.kind === "upload" && w.operation.target === widget.id && w.operation.source === field.name).map(w => <option key={w.id} value={w.id}>{w.title}</option>)}
                      </select>
                      <input aria-label={`Accepted MIME types for ${field.label}`} className={inputClassName} placeholder="image/*,application/pdf,text/csv" value={field.accept || ""} onChange={e => updateField(fieldIndex, { accept: e.target.value || undefined })} />
                      <input aria-label={`File size limit for ${field.label}`} className={inputClassName} type="number" min={1} max={20971520} placeholder="10485760 bytes" value={field.maxBytes || ""} onChange={e => updateField(fieldIndex, { maxBytes: Number(e.target.value) || undefined })} />
                    </>}

                    {field.type === "select" ? (
                      <>
                        <input
                          aria-label={`Options for ${field.label}`}
                          className={inputClassName}
                          placeholder="Options, separated, by commas"
                          value={field.options?.join(", ") || ""}
                          onChange={(event) =>
                            updateField(fieldIndex, {
                              options: event.target.value
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean),
                            })
                          }
                        />
                        <select
                          aria-label={`Reference for ${field.label}`}
                          className={selectClassName}
                          value={field.optionsResource || ""}
                          onChange={(event) =>
                            updateField(fieldIndex, {
                              optionsResource: event.target.value || undefined,
                            })
                          }
                        >
                          <option value="">Static options only</option>
                          {resources
                            .filter((resource) => resource.startsWith("common"))
                            .map((resource) => (
                              <option key={resource}>{resource}</option>
                            ))}
                        </select>
                        {field.optionsResource && (
                          <select
                            aria-label={`Reference query for ${field.label}`}
                            className={selectClassName}
                            value={field.optionsAction || ""}
                            onChange={(e) =>
                              updateField(fieldIndex, {
                                optionsAction: e.target.value || undefined,
                              })
                            }
                          >
                            <option value="">
                              Choose a reference query action
                            </option>
                            {widgets
                              .filter(
                                (w) =>
                                  w.type === "action" &&
                                  w.operation?.kind === "query" &&
                                  w.operation.target === widget.id &&
                                  w.operation.source === field.optionsResource,
                              )
                              .map((w) => (
                                <option key={w.id} value={w.id}>
                                  {w.title}
                                </option>
                              ))}
                          </select>
                        )}
                      </>
                    ) : null}
                    <input
                      aria-label={`Default for ${field.label}`}
                      className={inputClassName}
                      placeholder="Default value (optional)"
                      value={field.defaultValue || ""}
                      onChange={(event) =>
                        updateField(fieldIndex, {
                          defaultValue: event.target.value || undefined,
                        })
                      }
                    />
                  </div>
                </div>
              ))}
              {(widget.fields?.length ?? 0) === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Add at least one declared field.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <p className="text-[11px] text-slate-500 dark:text-slate-400">
        {widget.type === "form"
          ? widget.resource?.startsWith("common")
            ? "Actions use app-scoped capability permissions. Only declared fields are submitted."
            : "Execution runs the bound workflow through Tier 1. Only declared fields are submitted."
          : "Data is read through the DX runtime endpoint, never through the Tier-3 product API."}
      </p>
      <Issues issues={issues} max={4} />
    </div>
  );
}

export function BuilderPanel({
  requestedPluginId,
  onSelected,
  product,
  catalog,
  plugins,
  loading,
  onChanged,
  onDirtyChange,
}: BuilderPanelProps) {
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [header, setHeader] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHeader(document.getElementById("workspace-studio-controls"));
  }, []);
  const [draft, setDraft] = useState<WorkspacePlugin | null>(null);
  const [baseline, setBaseline] = useState("");
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [past, setPast] = useState<WorkspacePlugin[]>([]);
  const [future, setFuture] = useState<WorkspacePlugin[]>([]);
  const lastEdit = useRef(0);
  const [template, setTemplate] = useState("blank");
  const [preview, setPreview] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newSlugTouched, setNewSlugTouched] = useState(false);
  const [newAudience, setNewAudience] = useState<"admin" | "member">("member");
  const [importOpen, setImportOpen] = useState(false);
  const [pendingBundle, setPendingBundle] = useState<PluginBundle | null>(null);
  const [importIssues, setImportIssues] = useState<ValidationIssue[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [buildArtifact, setBuildArtifact] = useState<BuildArtifact | null>(
    null,
  );
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [revisions, setRevisions] = useState<PluginRevisionSummary[]>([]);
  const [revisionsError, setRevisionsError] = useState<string | null>(null);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(
    null,
  );
  const fileInput = useRef<HTMLInputElement | null>(null);

  const artifactsQuery = useQuery({
    queryKey: ["workflow-artifacts"],
    queryFn: fetchWorkflowArtifacts,
    retry: false,
  });

  const resources = useMemo(
    () => catalogResources(catalog, product).map((resource) => resource.key),
    [catalog, product],
  );
  const roles = useMemo(
    () => catalogRoles(catalog, product),
    [catalog, product],
  );
  const widgetTypes = useMemo(
    () => catalogWidgetTypes(catalog, product),
    [catalog, product],
  );
  const actionTypes = useMemo(
    () => catalogActionTypes(catalog, product),
    [catalog, product],
  );
  const orgReadiness = catalog?.workflowOrgReadiness;
  const mutation = useMemo(() => catalogMutation(catalog), [catalog]);

  useEffect(() => {
    if (
      draft &&
      (!draft.id || !requestedPluginId || draft.id === requestedPluginId)
    )
      return;
    if (draft && snapshotOf(draft) !== baseline) return;
    const first = requestedPluginId
      ? plugins.find((plugin) => plugin.id === requestedPluginId)
      : plugins[0];
    if (requestedPluginId && !first) {
      setError(
        "The requested plugin is unavailable in this app. Choose an existing page below.",
      );
      return;
    }
    if (!first) {
      setBaseline("");
      setSelectedWidgetId(null);
      return;
    }
    const cloned = clonePlugin(first);
    setDraft(cloned);
    setBaseline(snapshotOf(cloned));
    setSelectedWidgetId(cloned.widgets[0]?.id ?? null);
  }, [plugins, draft, requestedPluginId]);

  const isDirty = Boolean(
    draft && (!draft.id || snapshotOf(draft) !== baseline),
  );
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);
  const allIssues = useMemo(
    () =>
      draft
        ? validatePluginDraft(draft, {
            allowedRoles: roles.length > 0 ? roles : undefined,
          })
        : [],
    [draft, roles],
  );
  const selectedIndex =
    draft?.widgets.findIndex((widget) => widget.id === selectedWidgetId) ?? -1;
  const selectedWidget =
    selectedIndex >= 0 ? (draft?.widgets[selectedIndex] ?? null) : null;

  const loadPlugin = (plugin: WorkspacePlugin) => {
    const cloned = clonePlugin(plugin);
    setDraft(cloned);
    setPast([]);
    setFuture([]);
    lastEdit.current = 0;
    setBaseline(snapshotOf(cloned));
    setSelectedWidgetId(cloned.widgets[0]?.id ?? null);
    setIssues([]);
    setError(null);
    setPreview(false);
  };

  const selectPlugin = (plugin: WorkspacePlugin) => {
    if (
      draft &&
      isDirty &&
      !window.confirm("Discard unsaved changes to this draft?")
    )
      return;
    loadPlugin(plugin);
    onSelected?.(plugin.id);
    setLibraryOpen(false);
  };

  const patchDraft = (patch: Partial<WorkspacePlugin>) => {
    if (!draft) return;
    if (Date.now() - lastEdit.current > 500)
      setPast((items) => [...items.slice(-49), clonePlugin(draft)]);
    lastEdit.current = Date.now();
    setFuture([]);
    setDraft({ ...draft, ...patch });
  };
  const patchWidget = (id: string, patch: Partial<WorkspaceWidget>) => {
    if (draft)
      patchDraft({
        widgets: draft.widgets.map((widget) =>
          widget.id === id ? { ...widget, ...patch } : widget,
        ),
      });
  };
  const undo = () => {
    if (!draft || !past.length) return;
    setFuture((items) => [clonePlugin(draft), ...items]);
    setDraft(past[past.length - 1]);
    setPast(past.slice(0, -1));
    lastEdit.current = 0;
  };
  const redo = () => {
    if (!draft || !future.length) return;
    setPast((items) => [...items, clonePlugin(draft)]);
    setDraft(future[0]);
    setFuture(future.slice(1));
    lastEdit.current = 0;
  };
  useEffect(() => {
    if (!isDirty) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [isDirty]);

  const addWidget = (type: WorkspaceWidgetType, index?: number) => {
    if (!draft || !canAddWidget(draft.widgets, type)) return;
    lastEdit.current = 0;
    const widget = defaultWidget(
      type,
      draft.widgets.map((item) => item.id),
      resources,
    );
    const widgets = [...draft.widgets];
    widgets.splice(index ?? widgets.length, 0, widget);
    patchDraft({ widgets });
    setSelectedWidgetId(widget.id);
    setPreview(false);
  };

  const moveWidget = (from: number, to: number) => {
    if (!draft || to < 0 || to >= draft.widgets.length) return;
    lastEdit.current = 0;
    patchDraft({ widgets: moveItem(draft.widgets, from, to) });
  };

  const save = async () => {
    if (!draft || busy) return;
    const validation = validatePluginDraft(draft, {
      allowedRoles: roles.length > 0 ? roles : undefined,
    });
    setIssues(validation);
    setError(null);
    if (validation.length > 0) return;
    setBusy("save");
    try {
      const body = {
        name: draft.name.trim(),
        slug: draft.slug.trim(),
        audience: draft.audience,
        roles: draft.roles,
        widgets: draft.widgets.map(toWriteWidget),
        ...(draft.id ? { version: draft.version } : {}),
      };
      const saved = draft.id
        ? await updatePlugin(draft.id, body)
        : await createPlugin({ ...body, product: draft.product });
      loadPlugin(saved);
      onSelected?.(saved.id);
      toast(draft.id ? "Draft saved." : "Plugin created as a draft.");
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    if (!draft?.id || busy) return;
    if (isDirty) {
      setError("Save the draft before publishing.");
      return;
    }
    if (allIssues.length > 0) {
      setIssues(allIssues);
      return;
    }
    const governance = actionGovernanceErrors(draft.widgets);
    if (governance.length) {
      setError(governance.join("; "));
      return;
    }
    setBusy("publish");
    setError(null);
    try {
      const published = await publishPlugin(draft.id, draft.version);
      loadPlugin(published);
      toast("Published immutable snapshot.");
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const unpublish = async () => {
    if (!draft?.id || busy) return;
    setBusy("unpublish");
    setError(null);
    try {
      const result = await unpublishPlugin(draft.id, draft.version);
      loadPlugin(result);
      toast("Plugin unpublished.");
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const exportBundle = async () => {
    if (!draft?.id || busy) return;
    setBusy("export");
    setError(null);
    try {
      // Export is the authoring/backup view and intentionally serializes the
      // editable draft. The Tier-3 build below uses the immutable snapshot.
      const raw = await exportPluginBundle(draft.id, { draft: true });
      const parsed = parsePluginBundle(raw);
      if (!parsed.ok) {
        setIssues(parsed.issues);
        setError(
          "The exported bundle failed client validation; nothing was downloaded.",
        );
        return;
      }
      downloadJson(exportBundleFileName(draft), raw);
      toast("Draft bundle downloaded.");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const buildForTier3 = async () => {
    if (!draft?.id || busy) return;
    setBusy("build");
    setError(null);
    try {
      const raw = await buildPluginBundle(draft.id);
      const parsed = parsePluginBundle(raw);
      if (!parsed.ok || !parsed.bundle.source) {
        if (!parsed.ok) setIssues(parsed.issues);
        setError(
          "The Tier-3 build failed client validation; nothing was downloaded.",
        );
        return;
      }
      const filename =
        parsed.bundle.source.path.split("/").pop() ||
        `${draft.slug}.plugin.json`;
      downloadJson(filename, raw);
      setBuildArtifact({
        pluginName: parsed.bundle.plugin.name,
        version: draft.publishedVersion ?? draft.version,
        repository: parsed.bundle.source.repository,
        path: parsed.bundle.source.path,
        checksum: parsed.bundle.checksum ?? "missing",
        filename,
      });
      toast("Tier-3 build downloaded.");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const openRevisions = async () => {
    if (!draft?.id) return;
    setRevisionsOpen(true);
    setRevisionsError(null);
    try {
      setRevisions(await fetchPluginRevisions(draft.id));
    } catch (failure) {
      setRevisions([]);
      setRevisionsError(errorText(failure));
    }
  };

  const restoreRevision = async (version: number) => {
    if (!draft?.id || restoringVersion !== null) return;
    setRestoringVersion(version);
    setRevisionsError(null);
    try {
      const restored = await restorePluginRevision(draft.id, version);
      loadPlugin(restored);
      toast(
        `Revision v${version} restored as a new draft (v${restored.version}). History was not rewritten.`,
      );
      setRevisionsOpen(false);
      onChanged();
    } catch (failure) {
      setRevisionsError(errorText(failure));
    } finally {
      setRestoringVersion(null);
    }
  };

  const readImportFile = async (file: File | null) => {
    if (!file) return;
    setImportIssues([]);
    setImportError(null);
    setPendingBundle(null);
    if (file.size > 256 * 1024) {
      setImportIssues([
        { path: "file", message: "Bundle file must be 256 KiB or smaller." },
      ]);
      setImportOpen(true);
      return;
    }
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setImportIssues([
          { path: "file", message: "The file is not valid JSON." },
        ]);
        setImportOpen(true);
        return;
      }
      const result = parsePluginBundle(parsed);
      if (!result.ok) {
        setImportIssues(result.issues);
        setImportOpen(true);
        return;
      }
      setPendingBundle(result.bundle);
      setImportOpen(true);
    } catch (failure) {
      setImportIssues([{ path: "file", message: errorText(failure) }]);
      setImportOpen(true);
    }
  };

  const confirmImport = async () => {
    if (!pendingBundle || busy) return;
    if (pendingBundle.plugin.product !== product) {
      setImportError(
        `Select the ${pendingBundle.plugin.product} workspace before importing this bundle.`,
      );
      return;
    }
    setBusy("import");
    setImportError(null);
    try {
      const imported = await importPluginBundle(pendingBundle);
      loadPlugin(imported);
      setImportOpen(false);
      setPendingBundle(null);
      toast("Bundle imported as a draft. It was not installed.");
      onChanged();
    } catch (failure) {
      setImportError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const createNew = () => {
    const name = newName.trim();
    const slug = (newSlugTouched ? newSlug : slugify(name)).trim();
    if (!name || !slug) {
      setIssues([{ path: "name", message: "A name and slug are required." }]);
      return;
    }
    const plugin: WorkspacePlugin = {
      id: "",
      product,
      name,
      slug,
      audience: newAudience,
      roles: roles.includes("admin") ? ["admin"] : roles.slice(0, 1),
      widgets: [
        "tasks",
        "projects",
        "workspace",
        "inbox",
        "forms",
        "reports",
        "ocr",
        "assistant",
      ].includes(template)
        ? commonTemplateForSection(template)
        : template !== "blank"
          ? [
              {
                id: "page-heading",
                type: "heading",
                title: name,
                text: "Your organization workspace",
                width: "full",
              },
              {
                id: "workspace-navigation",
                type: "navigation",
                title: "Quick access",
                width: "full",
                links: MODULE_CATALOG.slice(0, 6).map((item) => ({
                  label: item.label,
                  target: `module:${item.id}`,
                })),
              },
              {
                id: "capability-content",
                type: "capability",
                title:
                  MODULE_CATALOG.find((item) => item.id === template)?.label ??
                  name,
                module: template,
                width: "full",
              },
            ]
          : [],
      status: "draft",
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      installed: false,
    };
    setDraft(plugin);
    setLibraryOpen(false);
    setPreview(false);
    onSelected?.("");
    setPast([]);
    setFuture([]);
    lastEdit.current = 0;
    setBaseline(snapshotOf(plugin));
    setSelectedWidgetId(null);
    setIssues([]);
    setError(null);
    setNewOpen(false);
    setNewName("");
    setNewSlug("");
    setNewSlugTouched(false);
    setNewAudience("member");
  };

  useEffect(() => {
    const requested = new URLSearchParams(window.location.hash.slice(1)).get(
      "template",
    );
    if (
      requested &&
      (CAPABILITY_MODULES as readonly string[]).includes(requested)
    ) {
      setTemplate(requested);
      setNewName(
        MODULE_CATALOG.find((item) => item.id === requested)?.label ??
          "Workspace",
      );
      setNewOpen(true);
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    }
  }, [product]);

  const roleOptions = useMemo(() => {
    const union = new Set<string>([...roles, ...(draft?.roles ?? [])]);
    return Array.from(union);
  }, [roles, draft]);

  const artifactOptions = artifactsQuery.data ?? [];
  const pluginToolbar = (
    <div className="flex flex-wrap items-center gap-2 border-t border-dx-line px-3 py-2">
      <span className="text-xs font-semibold text-dx-muted">Plugin</span>
      <select
        aria-label="Choose page"
        className="min-w-32 max-w-64 rounded-lg border border-dx-line bg-dx-subtle px-3 py-2 text-xs font-medium"
        value={draft?.id || ""}
        onChange={(event) => {
          const plugin = plugins.find((item) => item.id === event.target.value);
          if (plugin) selectPlugin(plugin);
        }}
      >
        {!draft?.id ? (
          <option value="">
            {draft ? `${draft.name} · unsaved` : "Select a page"}
          </option>
        ) : null}
        {plugins.map((plugin) => (
          <option key={plugin.id} value={plugin.id}>
            {plugin.name}
          </option>
        ))}
      </select>
      <Button variant="ghost" onClick={() => setLibraryOpen(true)}>
        Plugin library
      </Button>
      <span className="mr-auto hidden text-xs text-dx-muted 2xl:block">
        {loading ? "Syncing…" : `${plugins.length} saved pages`}
      </span>
      {draft && (
        <>
          <Button variant="ghost" onClick={() => setSettingsOpen(true)}>
            Page settings
          </Button>
          {draft.id ? (
            <Button
              variant="ghost"
              onClick={() => void openRevisions()}
              disabled={Boolean(busy)}
              aria-label="Revision history"
            >
              <History size={14} /> Revisions
            </Button>
          ) : null}
        </>
      )}
      <Button
        variant="ghost"
        onClick={() => void onChanged()}
        disabled={Boolean(busy)}
        aria-label="Refresh pages"
      >
        <RefreshCw size={14} />
      </Button>
      <Button
        variant="ghost"
        onClick={() => fileInput.current?.click()}
        disabled={Boolean(busy)}
      >
        <Upload size={14} /> Import bundle
      </Button>
      <Button
        variant="primary"
        onClick={() => {
          if (
            !isDirty ||
            window.confirm("Discard unsaved changes to this draft?")
          )
            setNewOpen(true);
        }}
        disabled={Boolean(busy)}
      >
        <Plus size={14} /> New plugin
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <Modal
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        title="Existing plugins"
        eyebrow={
          product === "sos"
            ? "SynapseCity SOS"
            : product === "city"
              ? "SynapseCity"
              : "Capability templates"
        }
        wide
      >
        <div className="border-t border-dx-line p-4">
          <input
            aria-label="Search existing plugins"
            placeholder="Find a page by name or slug…"
            className="mb-3 w-full rounded-lg border border-dx-line bg-dx-subtle px-3 py-2 text-sm"
            value={librarySearch}
            onChange={(e) => setLibrarySearch(e.target.value)}
          />
          <div className="grid max-h-80 gap-3 overflow-auto sm:grid-cols-2 xl:grid-cols-3">
            {plugins
              .filter((plugin) =>
                (plugin.name + " " + plugin.slug)
                  .toLowerCase()
                  .includes(librarySearch.toLowerCase()),
              )
              .map((plugin) => (
                <button
                  key={plugin.id}
                  type="button"
                  aria-label={`Edit ${plugin.name}`}
                  onClick={() => selectPlugin(plugin)}
                  className={`rounded-xl border p-4 text-left hover:border-indigo-400 ${draft?.id === plugin.id ? "border-indigo-400 bg-indigo-50 dark:bg-indigo-950/30" : "border-dx-line"}`}
                >
                  <span className="block text-sm font-semibold">
                    {plugin.name}
                  </span>
                  <span className="mt-1 block font-mono text-[10px] text-dx-muted">
                    {plugin.slug}
                  </span>
                  <span className="mt-3 block text-xs text-dx-muted">
                    {plugin.installed ? "Installed · " : ""}
                    {plugin.status} · v{plugin.version} ·{" "}
                    {plugin.widgets.length} components
                  </span>
                  {/* Source sync chip: stored build provenance only — the
                      console makes no network call to check the repository. */}
                  <span
                    aria-label={`Source sync for ${plugin.name}`}
                    className={`mt-2 inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                      plugin.lastBuild
                        ? "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-300"
                        : "border-dx-line bg-dx-subtle text-dx-muted"
                    }`}
                  >
                    {plugin.lastBuild ? (
                      <>
                        <span
                          className="inline-block size-1.5 rounded-full bg-teal-500"
                          aria-hidden="true"
                        />
                        built {relativeTime(plugin.lastBuild.builtAt)} ·
                        checksum{" "}
                        {plugin.lastBuild.checksum
                          .replace(/^sha256:/, "")
                          .slice(0, 8)}
                      </>
                    ) : (
                      "never built"
                    )}
                  </span>
                </button>
              ))}
          </div>
        </div>
      </Modal>
      {header ? createPortal(pluginToolbar, header) : pluginToolbar}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          void readImportFile(event.target.files?.[0] ?? null);
          event.target.value = "";
        }}
      />

      {error ? <ModalError message={error} /> : null}
      {issues.length > 0 ? <Issues issues={issues} /> : null}
      {draft && actionGovernanceErrors(draft.widgets).length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <span>
            {actionGovernanceErrors(draft.widgets).length} action connections
            need attention before publishing.
          </span>
          <Button
            onClick={() => {
              patchDraft({ widgets: materializeActions(draft.widgets) });
            }}
          >
            Create actions for legacy bindings
          </Button>
        </div>
      )}

      <div className="space-y-4">
        {draft ? (
          <div className="space-y-4">
            {header &&
              createPortal(
                <div className="flex flex-wrap items-center gap-3 border-t border-dx-line px-3 py-2">
                  <div className="mr-auto min-w-32">
                    <h2 className="text-sm font-semibold text-dx-fg">
                      {draft.name || "Untitled page"}
                    </h2>
                    <p className="mt-0.5 text-[10px] text-dx-muted">
                      {isDirty
                        ? "Unsaved changes"
                        : draft.id
                          ? "All changes saved"
                          : "New draft"}{" "}
                      · {draft.status}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <>
                      <Button
                        variant="ghost"
                        onClick={() => setPreview((value) => !value)}
                      >
                        <Wand2 size={14} /> {preview ? "Edit" : "Preview"}
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() => void save()}
                        disabled={
                          Boolean(busy) || (!isDirty && Boolean(draft.id))
                        }
                      >
                        <Save size={14} />{" "}
                        {busy === "save" ? "Saving…" : "Save draft"}
                      </Button>
                      <Button
                        variant="ok"
                        onClick={() => void publish()}
                        disabled={
                          Boolean(busy) ||
                          !draft.id ||
                          isDirty ||
                          allIssues.length > 0
                        }
                      >
                        {busy === "publish" ? "Publishing…" : "Publish"}
                      </Button>
                      {draft.id && draft.status === "published" ? (
                        <Button
                          variant="warn"
                          onClick={() => void unpublish()}
                          disabled={Boolean(busy)}
                        >
                          {busy === "unpublish" ? "Working…" : "Unpublish"}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        onClick={() => void exportBundle()}
                        disabled={Boolean(busy) || !draft.id || isDirty}
                        title={
                          isDirty
                            ? "Save the draft before exporting it."
                            : undefined
                        }
                      >
                        <Download size={14} /> Export draft
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() => void buildForTier3()}
                        disabled={
                          Boolean(busy) ||
                          !draft.id ||
                          isDirty ||
                          draft.status !== "published"
                        }
                        title={
                          isDirty
                            ? "Save and publish the current draft before building a Tier-3 artifact."
                            : draft.status === "published"
                              ? `Builds the immutable published snapshot${draft.publishedVersion !== undefined ? ` (v${draft.publishedVersion})` : ""}. Publish again to include newer draft changes.`
                              : "Publish the plugin before building a Tier-3 artifact."
                        }
                      >
                        <Download size={14} />{" "}
                        {busy === "build" ? "Building…" : "Build bundle"}
                      </Button>
                    </>
                  </div>
                </div>,
                header,
              )}
            <Modal
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              title="Page settings"
              wide
            >
              <div className="grid gap-3 px-5 py-4 lg:grid-cols-2">
                <Field label="Name" required>
                  <input
                    className={inputClassName}
                    value={draft.name}
                    maxLength={160}
                    onChange={(event) =>
                      patchDraft({ name: event.target.value })
                    }
                  />
                </Field>
                <Field
                  label="Slug"
                  required
                  help="Used in portable bundle filenames and repository sync."
                >
                  <input
                    className={inputClassName}
                    value={draft.slug}
                    maxLength={64}
                    onChange={(event) =>
                      patchDraft({ slug: event.target.value })
                    }
                  />
                </Field>
                <Field label="Audience">
                  <select
                    className={selectClassName}
                    value={draft.audience}
                    onChange={(event) =>
                      patchDraft({
                        audience: event.target.value as "admin" | "member",
                      })
                    }
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </Field>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  <p>
                    Product: <span className="font-mono">{draft.product}</span>
                  </p>
                  <p>
                    Version: {draft.version}
                    {draft.publishedVersion !== undefined
                      ? ` · published ${draft.publishedVersion}`
                      : ""}
                  </p>
                  <p>Status: {draft.status}</p>
                </div>
              </div>
              <div className="border-t border-slate-100 px-5 py-3 dark:border-[#1f2c40]">
                <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                  Audience roles
                </p>
                {roleOptions.length === 0 ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    The catalog did not advertise roles. Role updates stay
                    server-validated.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {roleOptions.map((role) => (
                      <label
                        key={role}
                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 dark:border-[#26354d] dark:text-slate-200"
                      >
                        <input
                          type="checkbox"
                          checked={draft.roles.includes(role)}
                          onChange={(event) =>
                            patchDraft({
                              roles: event.target.checked
                                ? [...draft.roles, role]
                                : draft.roles.filter((item) => item !== role),
                            })
                          }
                        />
                        {role}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </Modal>

            {preview ? (
              <div className="grid grid-cols-12 gap-4 rounded-2xl border border-dx-line bg-dx-surface p-6">
                {draft.widgets
                  .filter((widget) => widget.type !== "action")
                  .map((widget) => (
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
                      <SafeWidget widget={widget} preview />
                    </div>
                  ))}
              </div>
            ) : (
              <VisualDesigner
                widgets={draft.widgets}
                types={widgetTypes}
                selected={selectedWidgetId}
                onSelect={setSelectedWidgetId}
                onAdd={addWidget}
                onMove={moveWidget}
                onPatch={patchWidget}
                onRemove={(id) => {
                  lastEdit.current = 0;
                  const widgets = draft.widgets.filter(
                    (item) => item.id !== id,
                  );
                  patchDraft({ widgets });
                  if (id === selectedWidgetId)
                    setSelectedWidgetId(widgets[0]?.id ?? null);
                }}
                onDuplicate={(id) => {
                  const original = draft.widgets.find((item) => item.id === id);
                  if (!original || !canAddWidget(draft.widgets, original.type))
                    return;
                  const copy = {
                    ...JSON.parse(JSON.stringify(original)),
                    id: nextWidgetId(
                      original.type,
                      draft.widgets.map((item) => item.id),
                    ),
                    title: `${original.title.slice(0, 190)} copy`,
                  };
                  lastEdit.current = 0;
                  patchDraft({ widgets: [...draft.widgets, copy] });
                  setSelectedWidgetId(copy.id);
                }}
                undo={undo}
                redo={redo}
                canUndo={past.length > 0}
                canRedo={future.length > 0}
                inspector={
                  selectedWidget ? (
                    <WidgetEditor
                      widgets={draft.widgets}
                      key={selectedWidget.id}
                      widget={selectedWidget}
                      index={selectedIndex}
                      resources={resources}
                      artifacts={artifactOptions}
                      artifactsError={
                        artifactsQuery.error
                          ? errorText(artifactsQuery.error)
                          : null
                      }
                      formExecutionReady={
                        catalog?.workflowExecution?.ready ??
                        mutation.formExecution
                      }
                      formExecutionRequirement={
                        catalog?.workflowExecution?.requirement ??
                        mutation.reason
                      }
                      actions={actionTypes}
                      orgReadiness={orgReadiness}
                      unavailableActions={catalogUnavailableActions(
                        catalog,
                        product,
                        selectedWidget.resource || "",
                      )}
                      onChange={(patch) =>
                        patchWidget(selectedWidget.id, patch)
                      }
                    />
                  ) : (
                    <EmptyState
                      title="Select a component"
                      message="Click a component on the canvas to edit its properties."
                    />
                  )
                }
              />
            )}
          </div>
        ) : (
          <Card className="flex items-center justify-center py-16">
            <EmptyState
              icon={<FileJson size={20} />}
              title="No plugin selected"
              message="Create a plugin or import a portable bundle to start designing a page."
              action={
                <Button variant="primary" onClick={() => setNewOpen(true)}>
                  <Plus size={14} /> New plugin
                </Button>
              }
            />
          </Card>
        )}
      </div>

      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New workspace plugin"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={createNew}>
              Create draft
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {
            <Field label="Start from your existing workspace">
              <select
                className={selectClassName}
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
              >
                <option value="blank">Blank page</option>
                {MODULE_CATALOG.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.lane} · {item.label}
                  </option>
                ))}
              </select>
            </Field>
          }
          <Field label="Name" required>
            <input
              className={inputClassName}
              value={newName}
              maxLength={160}
              onChange={(event) => {
                setNewName(event.target.value);
                if (!newSlugTouched) setNewSlug(slugify(event.target.value));
              }}
            />
          </Field>
          <Field label="Slug" required>
            <input
              className={inputClassName}
              value={newSlug}
              maxLength={64}
              onChange={(event) => {
                setNewSlugTouched(true);
                setNewSlug(event.target.value);
              }}
            />
          </Field>
          <Field label="Audience">
            <select
              className={selectClassName}
              value={newAudience}
              onChange={(event) =>
                setNewAudience(event.target.value as "admin" | "member")
              }
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
        </div>
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          setPendingBundle(null);
          setImportIssues([]);
          setImportError(null);
        }}
        title="Import portable bundle"
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void confirmImport()}
              disabled={!pendingBundle || Boolean(busy)}
            >
              {busy === "import" ? "Importing…" : "Import as draft"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Imports create a DRAFT and never auto-install. Server state, tenant
            ids, tokens and membership are rejected.
          </p>
          <Issues issues={importIssues} max={12} />
          <ModalError message={importError} />
          {pendingBundle ? (
            <div className="rounded-xl border border-slate-200 p-3 text-sm dark:border-[#26354d]">
              <p className="font-semibold text-slate-900 dark:text-slate-100">
                {pendingBundle.plugin.name}
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {pendingBundle.plugin.product} · {pendingBundle.plugin.audience}{" "}
                · {pendingBundle.plugin.widgets.length} widget(s) · roles:{" "}
                {pendingBundle.plugin.roles.join(", ") || "none"}
              </p>
              {pendingBundle.source?.repository ? (
                <p className="mt-1 break-all text-xs text-slate-500 dark:text-slate-400">
                  source: {pendingBundle.source.repository}
                  {pendingBundle.source.path
                    ? `/${pendingBundle.source.path}`
                    : ""}
                </p>
              ) : null}
              {pendingBundle.checksum ? (
                <p className="mt-1 break-all font-mono text-[11px] text-slate-500 dark:text-slate-400">
                  {pendingBundle.checksum}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={buildArtifact !== null}
        onClose={() => setBuildArtifact(null)}
        title="Portable build ready"
        eyebrow={
          buildArtifact
            ? `${buildArtifact.pluginName} · published v${buildArtifact.version}`
            : undefined
        }
        footer={
          <Button variant="primary" onClick={() => setBuildArtifact(null)}>
            Done
          </Button>
        }
      >
        {buildArtifact ? (
          <div className="space-y-3 text-sm">
            <p className="text-slate-600 dark:text-slate-300">
              The bundle was built from the immutable published snapshot. Commit
              it to the owning repository; the Tier-3 sync CLI validates the
              same checksum and provenance.
            </p>
            <dl className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-[#26354d]">
              <div>
                <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Repository
                </dt>
                <dd className="break-all font-mono text-xs text-slate-800 dark:text-slate-200">
                  {buildArtifact.repository}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Tracked path
                </dt>
                <dd className="break-all font-mono text-xs text-slate-800 dark:text-slate-200">
                  {buildArtifact.path}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Checksum
                </dt>
                <dd className="break-all font-mono text-xs text-slate-800 dark:text-slate-200">
                  {buildArtifact.checksum}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Downloaded file:{" "}
              <span className="font-mono">{buildArtifact.filename}</span>. No
              secret, token, tenant id or environment-specific artifact id is
              included.
            </p>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={revisionsOpen}
        onClose={() => setRevisionsOpen(false)}
        title="Revision history"
        eyebrow={draft ? `${draft.name} · v${draft.version}` : undefined}
        wide
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Restoring a revision copies its widgets and settings into a{" "}
            <strong>new draft version</strong> through the normal update path.
            The stored history is never rewritten, and the restored draft is
            editable and publishable as usual.
          </p>
          <ModalError message={revisionsError} />
          {revisions.length === 0 && !revisionsError ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No revisions yet. Save or publish the draft to create history.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-[#1f2c40]">
              {revisions.map((revision) => (
                <li
                  key={revision.version}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
                >
                  <span className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
                    v{revision.version}
                  </span>
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-600 dark:bg-[#1a2740] dark:text-slate-300">
                    {revision.status}
                  </span>
                  <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                    {relativeTime(revision.createdAt)}
                    {revision.createdBy ? ` · ${revision.createdBy}` : ""}
                  </span>
                  <span className="max-w-full truncate font-mono text-[10px] text-slate-400">
                    {revision.checksum.replace(/^sha256:/, "").slice(0, 12)}
                  </span>
                  <span className="ml-auto">
                    <Button
                      variant="ghost"
                      onClick={() => void restoreRevision(revision.version)}
                      disabled={restoringVersion !== null}
                      aria-label={`Restore revision v${revision.version}`}
                    >
                      {restoringVersion === revision.version
                        ? "Restoring…"
                        : `Restore v${revision.version}`}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
    </div>
  );
}
