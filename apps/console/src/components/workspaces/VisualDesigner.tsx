import { actionUsages } from "../../lib/studioActions";
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState, type ReactNode, type DragEvent } from "react";
import {
  Search,
  GripVertical,
  Copy,
  Trash2,
  Monitor,
  Smartphone,
  PanelLeft,
  Zap,
  MousePointer2,
  Plus,
  Undo2,
  Redo2,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { SafeWidget } from "./SafeWidget";
import { cn } from "../../lib/utils";
import {
  MAX_WIDGETS,
  canAddWidget,
  type WorkspaceWidget,
  type WorkspaceWidgetType,
} from "../../lib/workspaces";

export const COMPONENTS: Array<{
  type: WorkspaceWidgetType;
  label: string;
  group: string;
  glyph: string;
}> = [
  { type: "action", label: "Action", group: "Actions", glyph: "ϟ" },
  { type: "code", label: "Custom code", group: "Code", glyph: "</>" },
  { type: "heading", label: "Heading", group: "Content", glyph: "H₁" },
  { type: "text", label: "Text", group: "Content", glyph: "T" },
  { type: "alert", label: "Callout", group: "Content", glyph: "!" },
  { type: "divider", label: "Divider", group: "Content", glyph: "―" },
  { type: "navigation", label: "Navigation", group: "Navigation", glyph: "☰" },
  { type: "tabs", label: "Page tabs", group: "Navigation", glyph: "⊟" },
  { type: "button", label: "Button", group: "Navigation", glyph: "↗" },
  { type: "metric", label: "Metric", group: "Data", glyph: "01" },
  { type: "table", label: "Table", group: "Data", glyph: "▦" },
  { type: "map", label: "Map", group: "Data", glyph: "⌖" },
  { type: "chart", label: "Chart · 5 types", group: "Data", glyph: "▥" },
  { type: "list", label: "List", group: "Data", glyph: "≡" },
  { type: "progress", label: "Progress", group: "Data", glyph: "◔" },
  { type: "form", label: "Form", group: "Actions", glyph: "▤" },
  { type: "kanban", label: "Kanban board", group: "Data", glyph: "▥" },
  { type: "timeline", label: "Timeline", group: "Data", glyph: "⋮" },
  { type: "markdown", label: "Rich text", group: "Content", glyph: "M↓" },
];
export function VisualDesigner({
  widgets,
  types,
  selected,
  onSelect,
  onAdd,
  onMove,
  onPatch,
  onRemove,
  onDuplicate,
  inspector,
  undo,
  redo,
  canUndo,
  canRedo,
}: {
  widgets: WorkspaceWidget[];
  types: WorkspaceWidgetType[];
  selected: string | null;
  onSelect: (id: string) => void;
  onAdd: (type: WorkspaceWidgetType, index?: number) => void;
  onMove: (from: number, to: number) => void;
  onPatch: (id: string, patch: Partial<WorkspaceWidget>) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  inspector: ReactNode;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const [search, setSearch] = useState("");
  const [section, setSection] = useState("");
  const sections = [
    ...new Set(widgets.map((widget) => widget.section).filter(Boolean)),
  ] as string[];
  const [panel, setPanel] = useState<"components" | "layers" | "actions">(
    "components",
  );
  const [mobile, setMobile] = useState(false);
  const [over, setOver] = useState<number | null>(null);
  const drop = (event: DragEvent, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    setOver(null);
    const type = event.dataTransfer.getData(
      "application/x-dx-component",
    ) as WorkspaceWidgetType;
    const id = event.dataTransfer.getData("application/x-dx-widget");
    if (type && types.includes(type)) onAdd(type, index);
    else if (id) {
      const from = widgets.findIndex((widget) => widget.id === id);
      if (from >= 0) onMove(from, Math.min(index, widgets.length - 1));
    }
  };
  return (
    <div className="overflow-hidden rounded-2xl border border-dx-line bg-dx-surface shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-dx-line px-4 py-2.5">
        <MousePointer2 size={14} className="text-indigo-500" />
        <span className="mr-auto text-xs font-semibold">Design canvas</span>
        <button
          type="button"
          className="designer-tool"
          title="Undo"
          aria-label="Undo"
          disabled={!canUndo}
          onClick={undo}
        >
          <Undo2 size={15} />
        </button>
        <button
          type="button"
          className="designer-tool"
          title="Redo"
          aria-label="Redo"
          disabled={!canRedo}
          onClick={redo}
        >
          <Redo2 size={15} />
        </button>
        {sections.length ? (
          <select
            aria-label="Canvas section"
            className="rounded-lg border border-dx-line bg-dx-surface px-2 py-1.5 text-xs"
            value={section}
            onChange={(event) => setSection(event.target.value)}
          >
            <option value="">All sections</option>
            {sections.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        ) : null}
        <div className="mx-1 h-5 border-l border-dx-line" />
        <button
          type="button"
          aria-label="Desktop preview"
          aria-pressed={!mobile}
          className={cn(
            "designer-tool",
            !mobile && "bg-indigo-50 text-indigo-600",
          )}
          onClick={() => setMobile(false)}
        >
          <Monitor size={15} />
        </button>
        <button
          type="button"
          aria-label="Mobile preview"
          aria-pressed={mobile}
          className={cn(
            "designer-tool",
            mobile && "bg-indigo-50 text-indigo-600",
          )}
          onClick={() => setMobile(true)}
        >
          <Smartphone size={15} />
        </button>
      </div>
      <div className="grid xl:h-[calc(100dvh-340px)] xl:min-h-[640px] xl:max-h-[1200px] xl:grid-cols-[184px_minmax(0,1fr)_280px]">
        <aside className="overflow-y-auto border-b border-dx-line bg-dx-surface xl:border-b-0 xl:border-r">
          <div className="grid grid-cols-3 border-b border-dx-line p-1">
            {(["components", "layers", "actions"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-label={value.charAt(0).toUpperCase() + value.slice(1)}
                onClick={() => setPanel(value)}
                className={cn(
                  "min-w-0 rounded-lg px-0.5 py-2 text-[10px] font-semibold capitalize",
                  panel === value ? "bg-dx-subtle text-dx-fg" : "text-dx-muted",
                )}
              >
                {value}
              </button>
            ))}
          </div>
          {panel === "components" ? (
            <div className="p-3">
              <label className="mb-4 flex items-center gap-2 rounded-lg border border-dx-line px-2 py-2 text-dx-muted">
                <Search size={13} />
                <input
                  aria-label="Find component"
                  placeholder="Find component"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="min-w-0 bg-transparent text-xs outline-none"
                />
              </label>
              {[
                "Content",
                "Navigation",
                "Data",
                "Actions",
                "Code",
                "Capabilities",
              ].map((group) => {
                const entries = COMPONENTS.filter(
                  (item) =>
                    item.group === group &&
                    item.type !== "action" &&
                    types.includes(item.type) &&
                    item.label.toLowerCase().includes(search.toLowerCase()),
                );
                return entries.length ? (
                  <div className="mb-5" key={group}>
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-dx-muted">
                      {group}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {entries.map((item) => (
                        <button
                          key={item.type}
                          aria-label={item.label}
                          type="button"
                          draggable={canAddWidget(widgets, item.type)}
                          disabled={!canAddWidget(widgets, item.type)}
                          onDragStart={(event) => {
                            event.dataTransfer.setData(
                              "application/x-dx-component",
                              item.type,
                            );
                            event.dataTransfer.effectAllowed = "copy";
                          }}
                          onClick={() => onAdd(item.type)}
                          className="group flex cursor-grab flex-col items-center gap-2 rounded-lg border border-dx-line bg-dx-surface px-1 py-3 text-dx-muted transition hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-700 dark:hover:bg-indigo-950"
                        >
                          <span className="text-lg font-semibold leading-5">
                            {item.glyph}
                          </span>
                          <span className="text-[10px] font-medium">
                            {item.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null;
              })}
            </div>
          ) : panel === "actions" ? (
            <div className="space-y-3 p-3">
              <p className="text-[10px] leading-5 text-dx-muted">
                Every data source and business event uses a declared action.
                Create queries, presets and functions, then connect widget
                events.
              </p>
              <button
                type="button"
                disabled={
                  !types.includes("action") || !canAddWidget(widgets, "action")
                }
                onClick={() => onAdd("action")}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
              >
                <Plus size={13} /> New action
              </button>
              {widgets
                .filter((w) => w.type === "action")
                .map((w) => (
                  <div
                    key={w.id}
                    className={cn(
                      "rounded-xl border p-2",
                      selected === w.id
                        ? "border-indigo-400 bg-indigo-50 dark:bg-indigo-950/30"
                        : "border-dx-line",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(w.id)}
                      className="flex w-full items-start gap-2 text-left"
                    >
                      <Zap
                        size={14}
                        className="mt-0.5 shrink-0 text-indigo-500"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold">
                          {w.title}
                        </span>
                        <code className="mt-1 block truncate text-[10px] text-dx-muted">
                          {w.id}
                        </code>
                        <span className="mt-1 block text-[10px] text-dx-muted">
                          {w.operation?.kind || "function"}
                          {w.operation?.source
                            ? ` · ${w.operation.source}`
                            : ""}
                          <span className="mt-1 block">
                            {actionUsages(widgets, w.id).join("; ") ||
                              "Unconnected"}
                          </span>
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete action ${w.title}`}
                      onClick={() => onRemove(w.id)}
                      className="mt-2 rounded p-1 text-dx-muted hover:text-red-500"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
            </div>
          ) : (
            <div className="space-y-1 p-2">
              {widgets
                .filter((w) => w.type !== "action")
                .map((widget) => {
                  const index = widgets.findIndex((w) => w.id === widget.id);
                  return (
                    <button
                      key={widget.id}
                      type="button"
                      draggable
                      onDragStart={(event) =>
                        event.dataTransfer.setData(
                          "application/x-dx-widget",
                          widget.id,
                        )
                      }
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => drop(event, index)}
                      onClick={() => onSelect(widget.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs",
                        selected === widget.id
                          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                          : "text-dx-muted",
                      )}
                    >
                      <GripVertical size={12} />
                      <span className="truncate">{widget.title}</span>
                    </button>
                  );
                })}
            </div>
          )}
        </aside>
        <div
          aria-label="Widget design canvas"
          className="min-w-0 overflow-auto bg-dx-subtle p-3 sm:p-4"
          style={{
            backgroundImage:
              "radial-gradient(var(--color-dx-line, #dbe1eb) 1px, transparent 1px)",
            backgroundSize: "16px 16px",
          }}
        >
          <div
            className={cn(
              "mx-auto min-h-[540px] rounded-xl border border-dx-line bg-dx-surface p-4 shadow-sm transition-all",
              mobile ? "max-w-[375px]" : "w-full",
            )}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => drop(event, widgets.length)}
          >
            <div className="mb-5 flex items-center gap-1.5 border-b border-dx-line pb-3">
              <span className="h-2 w-2 rounded-full bg-red-300" />
              <span className="h-2 w-2 rounded-full bg-amber-300" />
              <span className="h-2 w-2 rounded-full bg-emerald-300" />
              <span className="ml-3 text-[10px] text-dx-muted">
                Your application
              </span>
            </div>
            <div className={cn("grid grid-cols-12 gap-4")}>
              {widgets.map((widget, index) =>
                widget.type !== "action" &&
                (!section || !widget.section || widget.section === section) ? (
                  <div
                    key={widget.id}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(
                        "application/x-dx-widget",
                        widget.id,
                      );
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setOver(null)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setOver(index);
                    }}
                    onDrop={(event) => drop(event, index)}
                    onClick={() => onSelect(widget.id)}
                    tabIndex={0}
                    role="group"
                    aria-label={`${widget.title}, ${widget.type}`}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(widget.id);
                      }
                      if (event.altKey && event.key === "ArrowUp") {
                        event.preventDefault();
                        onMove(index, index - 1);
                      }
                      if (event.altKey && event.key === "ArrowDown") {
                        event.preventDefault();
                        onMove(index, index + 1);
                      }
                      // Undo/redo shortcuts: Ctrl/Cmd+Z reverts the last edit,
                      // +Shift (or Ctrl/Cmd+Y) re-applies it. The buttons stay
                      // the visible affordance; this only removes the round
                      // trip to the toolbar.
                      if (
                        (event.ctrlKey || event.metaKey) &&
                        !event.altKey &&
                        (event.key === "z" || event.key === "Z")
                      ) {
                        event.preventDefault();
                        if (event.shiftKey) redo();
                        else undo();
                      }
                      if (
                        (event.ctrlKey || event.metaKey) &&
                        !event.altKey &&
                        !event.shiftKey &&
                        (event.key === "y" || event.key === "Y")
                      ) {
                        event.preventDefault();
                        redo();
                      }
                    }}
                    className={cn(
                      "group relative min-w-0 rounded-xl border-2 p-1 outline-none transition focus-visible:ring-2 focus-visible:ring-indigo-400",
                      mobile
                        ? "col-span-12"
                        : widget.width === "quarter"
                          ? "col-span-3"
                          : widget.width === "third"
                            ? "col-span-4"
                            : widget.width === "half"
                              ? "col-span-6"
                              : "col-span-12",
                      selected === widget.id
                        ? "border-indigo-500 bg-indigo-50/30 dark:bg-indigo-950/20"
                        : "border-transparent hover:border-indigo-200",
                      over === index && "border-t-indigo-500",
                    )}
                  >
                    <div className="pointer-events-none h-full select-none">
                      <SafeWidget widget={widget} preview />
                    </div>
                    {selected === widget.id ? (
                      <div
                        className="absolute -top-3 right-2 flex items-center gap-0.5 rounded-lg border border-indigo-200 bg-dx-surface p-0.5 shadow-sm"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="designer-tool"
                          aria-label="Move up"
                          disabled={index === 0}
                          onClick={() => onMove(index, index - 1)}
                        >
                          <ArrowUp size={12} />
                        </button>
                        <button
                          type="button"
                          className="designer-tool"
                          aria-label="Move down"
                          disabled={index === widgets.length - 1}
                          onClick={() => onMove(index, index + 1)}
                        >
                          <ArrowDown size={12} />
                        </button>
                        <button
                          type="button"
                          className="designer-tool"
                          aria-label="Duplicate component"
                          disabled={!canAddWidget(widgets, widget.type)}
                          onClick={() => onDuplicate(widget.id)}
                        >
                          <Copy size={12} />
                        </button>
                        <button
                          type="button"
                          className="designer-tool"
                          aria-label="Remove component"
                          onClick={() => onRemove(widget.id)}
                        >
                          <Trash2 size={12} />
                        </button>
                        <button
                          type="button"
                          className="designer-tool"
                          aria-label="Toggle component width"
                          onClick={() =>
                            onPatch(widget.id, {
                              width: widget.width === "full" ? "half" : "full",
                            })
                          }
                        >
                          <PanelLeft size={12} />
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null,
              )}
              <div
                className={cn(
                  "flex min-h-28 items-center justify-center rounded-xl border-2 border-dashed border-dx-line text-center text-dx-muted",
                  "col-span-12",
                )}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setOver(widgets.length);
                }}
                onDrop={(event) => drop(event, widgets.length)}
              >
                <div>
                  <Plus size={20} className="mx-auto mb-2 text-indigo-400" />
                  <p className="text-xs">Drop a component here</p>
                  <p className="mt-1 text-[10px]">
                    Or choose one from the library ·{" "}
                    {widgets.filter((w) => w.type !== "action").length}/
                    {MAX_WIDGETS}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
        <aside className="overflow-y-auto border-t border-dx-line bg-dx-surface xl:border-l xl:border-t-0">
          <div className="border-b border-dx-line px-4 py-3">
            <p className="text-xs font-semibold">
              {widgets.find((w) => w.id === selected)?.type === "action"
                ? "Action properties"
                : "Properties"}
            </p>
            <p className="mt-1 text-[10px] text-dx-muted">
              {widgets.find((widget) => widget.id === selected)?.type ??
                "Choose a component"}
            </p>
          </div>
          <div className="p-4">{inspector}</div>
        </aside>
      </div>
    </div>
  );
}
