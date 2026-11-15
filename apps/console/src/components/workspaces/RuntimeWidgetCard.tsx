// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Runtime widget card: loads DX widget data and executes bound forms in DX. */
import { useContext, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CodeWidget } from "./CodeWidget";
import { SafeWidget } from "./SafeWidget";
import { WorkspaceActions } from "./WorkspaceActions";
import { RecordSelection } from "./RecordSelection";
import { BoardActions } from "./CollectionViews";
import type { WidgetData } from "../../lib/workspaces";
import {
  parseWidgetData,
  formReasonMessage,
  type RuntimeWidget,
} from "../../lib/workspaces";

export function RuntimeWidgetCard({
  installedId,
  widgets = [],
  product,
  widget,
  cacheScope,
  formUnavailableReason,
}: {
  installedId: string;
  widgets?: RuntimeWidget[];
  product?: string;
  widget: RuntimeWidget;
  cacheScope: string;
  formUnavailableReason?: string | null;
}) {
  const actions = useContext(WorkspaceActions);
  const selection = useContext(RecordSelection);
  const [offset, setOffset] = useState(0),
    [search, setSearch] = useState(""),
    [term, setTerm] = useState("");
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);
  const read = widgets.find(w => w.id === widget.onLoad)?.operation;
  const accepts = (field: string) => read?.kind === "function" || read?.mappings.some(m => m.field === field && m.source === "event" && m.value === field);
  useEffect(() => {
    if (search === term) return;
    const id = setTimeout(() => {
      setTerm(search);
      setOffset(0);
      setPreviousOffsets([]);
    }, 300);
    return () => clearTimeout(id);
  }, [search, term]);
  const [submitting, setSubmitting] = useState(false);
  const needsData = [
    "metric",
    "table",
    "chart",
    "list",
    "map",
    "kanban",
    "timeline",
  ].includes(widget.type);

  const query = useQuery({
    queryKey: [
      "workspace-widget",
      cacheScope,
      installedId,
      widget.id,
      offset,
      term,
      widget.onLoad,
    ],
    queryFn: async () => {
      if (!actions || !widget.onLoad)
        throw new Error("Assign a query action in Studio before loading data");
      const value = (await actions.run(
        widget.onLoad,
        { limit: 50, offset, search: term },
        { silent: true },
      )) as WidgetData;
      if (
        !value ||
        !Array.isArray(value.rows) ||
        !Number.isFinite(value.total) ||
        !Array.isArray(value.columns)
      )
        throw new Error("Query functions must return {rows, total, columns}");
      return parseWidgetData(
        {
          type: widget.type,
          items: value.rows,
          total: value.total,
          count: value.total,
          columns: value.columns,
          limit: value.limit,
          offset: value.offset,
        },
        widget.type as "table",
      );
    },
    enabled: needsData && !!widget.onLoad && !!actions,
    retry: false,
  });

  const submit = async (values: Record<string, unknown>) => {
    setSubmitting(true);
    try {
      if (!actions || !widget.onSubmit)
        throw new Error("Assign a submit action in Studio first");
      return await actions.run(widget.onSubmit, { values }, { silent: true });
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (query.data) actions?.captureData(widget.id, query.data);
  }, [query.data, widget.id, actions?.captureData]);
  if (widget.type === "code" && widget.code)
    return (
      <CodeWidget
        key={widget.id}
        code={widget.code}
        title={widget.title}
        installedId={installedId}
        widgets={widgets}
        cacheScope={cacheScope}
        actionId={`code:${widget.id}`}
      />
    );

  const governedSelect = (_resource: string, row: Record<string, unknown>) => {
    if (widget.onRowClick)
      void actions?.run(widget.onRowClick, { row }).catch(() => {});
  };
  return (
    <RecordSelection.Provider
      value={{ selected: selection.selected, select: governedSelect }}
    >
      <BoardActions.Provider
        value={{
          canMove: () =>
            !!widget.onChange &&
            !!widgets.find((w) => w.id === widget.updateForm)?.canSubmit,
          move: async (_widget, row, value) => {
            if (!actions || !widget.onChange)
              throw new Error("Assign a change action first");
            await actions.run(
              widget.onChange,
              { row, value },
              { silent: true },
            );
          },
        }}
      >
        <div
          className={
            widget.width === "full"
              ? "flex min-w-0 flex-col sm:col-span-2"
              : "flex min-w-0 flex-col"
          }
        >
          {["table", "list", "map", "kanban", "timeline"].includes(
            widget.type,
          ) ? (
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <input
                aria-label={`Search ${widget.title}`}
                className="rounded-lg border border-dx-line bg-dx-surface px-3 py-2 text-xs outline-none focus:border-teal-500"
                placeholder="Search records…"
                value={search}
                disabled={!accepts("search")}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="flex items-center gap-2 text-xs text-dx-muted">
                <button
                  type="button"
                  disabled={!previousOffsets.length || query.isFetching || !accepts("offset")}
                  onClick={() => {
                    setOffset(previousOffsets.at(-1) || 0);
                    setPreviousOffsets(previousOffsets.slice(0, -1));
                  }}
                >
                  Previous
                </button>
                <span>
                  {query.data?.rows.length ? (query.data.offset ?? offset) + 1 : 0}–
                  {(query.data?.offset ?? offset) + (query.data?.rows.length || 0)} of{" "}
                  {query.data?.total || 0}
                </span>
                <button
                  type="button"
                  disabled={
                    query.isFetching || !accepts("offset") || !query.data?.rows.length ||
                    (query.data?.offset ?? offset) + (query.data?.rows.length || 0) >=
                    (query.data?.total || 0)
                  }
                  onClick={() => {
                    const start = query.data?.offset ?? offset;
                    setPreviousOffsets([...previousOffsets, start]);
                    setOffset(start + (query.data?.rows.length || 0));
                  }}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
          <SafeWidget
            installedId={installedId}
            widget={widget}
            product={product}
            data={query.data}
            dataLoading={query.isLoading}
            dataError={
              needsData && !widget.onLoad
                ? "No query action assigned. Open Studio to connect a declared source."
                : query.error
                  ? (query.error as Error).message
                  : null
            }
            formUnavailableReason={
              widget.canSubmit && widget.onSubmit
                ? null
                : !widget.onSubmit
                  ? "No submit action assigned"
                  : formReasonMessage(
                      widget.canSubmitReason,
                      formUnavailableReason,
                    )
            }
            onFormSubmit={widget.type === "form" ? submit : undefined}
            formBusy={submitting}
          />
        </div>
      </BoardActions.Provider>
    </RecordSelection.Provider>
  );
}
