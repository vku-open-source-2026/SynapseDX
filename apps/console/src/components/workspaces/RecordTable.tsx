// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useContext, useMemo, useState } from "react";
import { ArrowUpDown, Download, Eye } from "lucide-react";
import {
  safeCellText,
  type RuntimeWidget,
  type WidgetData,
} from "../../lib/workspaces";
import { WorkspaceActions } from "./WorkspaceActions";
import { RecordSelection } from "./RecordSelection";
import { EmptyState, Skeleton } from "../ui";

export function fieldLabel(name: string) {
  return name.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
function statusTone(value: unknown) {
  return /active|available|complete|resolved|approved|operational/.test(
    String(value),
  )
    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
    : /critical|high|reject|overdue|failed/.test(String(value))
      ? "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
}
export function RecordTable({
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
  const actions = useContext(WorkspaceActions);
  // Null-safe outside the member runtime (the admin builder preview renders
  // real data without a RecordSelection provider).
  const selection = useContext(RecordSelection);
  const select = selection?.select;
  const [sort, setSort] = useState<{ field: string; asc: boolean } | null>(
    null,
  );
  const columns = (widget.columns || data?.columns || []).filter(
    (column) => column !== "id",
  );
  const rows = useMemo(() => {
    const list = [...(data?.rows || [])];
    if (sort)
      list.sort(
        (a, b) =>
          String(a[sort.field] ?? "").localeCompare(
            String(b[sort.field] ?? ""),
            undefined,
            { numeric: true },
          ) * (sort.asc ? 1 : -1),
      );
    return list;
  }, [data, sort]);

  if (preview)
    return (
      <div className="rounded-xl border border-dx-line bg-dx-subtle p-5 text-xs text-dx-muted">
        Searchable records · {columns.map(fieldLabel).join(" / ")} · Details and
        actions
      </div>
    );
  if (loading) return <Skeleton className="h-48 w-full" />;
  if (error)
    return (
      <p role="alert" className="text-sm text-rose-600">
        {error}
      </p>
    );
  if (!rows.length)
    return (
      <EmptyState
        title="No matching records"
        message="Try changing your search or filters. New records will appear here after they are saved."
      />
    );
  return (
    <div>
      <div className="mb-3 flex items-center justify-between text-xs text-dx-muted">
        <span>{data?.total.toLocaleString()} records</span>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-lg border border-dx-line px-2.5 py-1.5 hover:bg-dx-subtle"
          disabled={!widget.onExport}
          onClick={() => {
            if (widget.onExport)
              void actions?.run(widget.onExport).catch(() => {});
          }}
        >
          <Download size={13} />
          Export this page
        </button>
      </div>
      <div className="overflow-x-auto rounded-xl border border-dx-line">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-dx-subtle">
            <tr>
              {columns.map((column) => (
                <th
                  key={column}
                  className="whitespace-nowrap px-4 py-3 font-medium text-dx-muted"
                >
                  <button
                    type="button"
                    className="flex items-center gap-2"
                    onClick={() =>
                      setSort({
                        field: column,
                        asc: sort?.field === column ? !sort.asc : true,
                      })
                    }
                  >
                    {fieldLabel(column)}
                    <ArrowUpDown size={11} />
                  </button>
                </th>
              ))}
              <th className="px-3">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dx-line">
            {rows.map((row, index) => (
              <tr
                key={String(row.id ?? index)}
                className="group hover:bg-dx-subtle/70"
              >
                {columns.map((column, i) => (
                  <td
                    key={column}
                    className="max-w-[19rem] truncate px-4 py-3.5"
                    title={safeCellText(row[column])}
                  >
                    {/status|severity|priority/.test(column) ? (
                      <span
                        className={
                          "rounded-md px-2 py-1 text-[10px] font-semibold " +
                          statusTone(row[column])
                        }
                      >
                        {safeCellText(row[column])}
                      </span>
                    ) : i === 0 ? (
                      <button
                        type="button"
                        onClick={() => select?.(widget.resource || "", row)}
                        className="font-semibold text-dx-fg hover:text-teal-600"
                      >
                        {safeCellText(row[column])}
                      </button>
                    ) : (
                      <span className="text-dx-muted">
                        {safeCellText(row[column])}
                      </span>
                    )}
                  </td>
                ))}
                <td className="px-3">
                  <button
                    type="button"
                    aria-label={`View ${safeCellText(row.name ?? row.title ?? row.id)}`}
                    className="rounded-lg p-2 text-dx-muted hover:bg-dx-line"
                    onClick={() => select?.(widget.resource || "", row)}
                  >
                    <Eye size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
