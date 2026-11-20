// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createContext, useContext, useState } from "react";
import type { RuntimeWidget, WidgetData } from "../../lib/workspaces";
import { safeCellText } from "../../lib/workspaces";
import { RecordSelection } from "./RecordSelection";

export const BoardActions = createContext<{
  canMove: (widget: RuntimeWidget) => boolean;
  move: (
    widget: RuntimeWidget,
    row: Record<string, unknown>,
    status: string,
  ) => Promise<void>;
}>({ canMove: () => false, move: async () => {} });

export function KanbanView({
  widget,
  data,
}: {
  widget: RuntimeWidget;
  data?: WidgetData;
}) {
  // Null-safe outside the member runtime (admin builder preview).
  const selection = useContext(RecordSelection);
  const select = selection?.select;
  const actions = useContext(BoardActions);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [over, setOver] = useState("");
  const rows = data?.rows || [],
    group = widget.groupBy || widget.columns?.[1] || "status";
  const groups = [
    ...new Set([
      ...(widget.groups || []),
      ...rows.map((row) => String(row[group] ?? "Unassigned")),
    ]),
  ];
  const writable = actions.canMove(widget);
  const move = async (row: Record<string, unknown>, status: string) => {
    if (busy || !writable || row[group] === status) return;
    setBusy(true);
    setError("");
    try {
      await actions.move(widget, row, status);
    } catch (failure) {
      setError((failure as Error).message || "Status could not be updated.");
    } finally {
      setBusy(false);
      setOver("");
    }
  };
  return (
    <div aria-busy={busy}>
      {error ? (
        <p
          role="alert"
          className="mb-3 rounded-lg bg-rose-50 p-3 text-xs text-rose-700"
        >
          {error}
        </p>
      ) : null}
      {writable ? (
        <p className="mb-3 text-xs text-dx-muted">
          Drag a card to change its status, or use the status menu on each card.
        </p>
      ) : null}
      <div className="flex gap-4 overflow-x-auto pb-3">
        {groups.map((status) => (
          <section
            key={status}
            aria-label={`${status.replaceAll("_", " ")} column`}
            onDragOver={(event) => {
              if (writable && !busy) {
                event.preventDefault();
                setOver(status);
              }
            }}
            onDragLeave={() => setOver("")}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData(`application/x-dx-card`);
              const row = rows.find((row) => String(row.id) === id);
              if (row) void move(row, status);
            }}
            className={`min-w-[240px] flex-1 rounded-xl border p-3 ${over === status ? "border-teal-400 bg-teal-50 dark:bg-teal-950" : "border-transparent bg-dx-subtle"}`}
          >
            <div className="mb-3 flex items-center justify-between text-xs font-semibold capitalize">
              <span>{status.replaceAll("_", " ")}</span>
              <span className="rounded-md bg-dx-surface px-2 py-1 text-dx-muted">
                {
                  rows.filter(
                    (row) => String(row[group] ?? "Unassigned") === status,
                  ).length
                }
              </span>
            </div>
            <div className="space-y-2">
              {rows
                .filter((row) => String(row[group] ?? "Unassigned") === status)
                .map((row) => (
                  <article
                    key={String(row.id)}
                    draggable={writable && !busy}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(
                        "application/x-dx-card",
                        String(row.id),
                      );
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    className="rounded-lg border border-dx-line bg-dx-surface p-4 shadow-sm hover:border-teal-400"
                  >
                    <button
                      onClick={() => select?.(widget.resource || "", row)}
                      className="block w-full text-left text-sm font-semibold"
                    >
                      {safeCellText(row[widget.columns?.[0] || "title"])}
                    </button>
                    <p className="mt-3 text-[10px] text-dx-muted">
                      {widget.columns
                        ?.slice(2)
                        .map((key) => safeCellText(row[key]))
                        .join(" · ")}
                    </p>
                    {writable ? (
                      <select
                        disabled={busy}
                        aria-label={`Status for ${safeCellText(row[widget.columns?.[0] || "title"])}`}
                        value={String(row[group])}
                        onChange={(event) => void move(row, event.target.value)}
                        className="mt-3 w-full rounded-md border border-dx-line bg-dx-surface px-2 py-1.5 text-[11px] capitalize"
                      >
                        {groups.map((value) => (
                          <option key={value} value={value}>
                            {value.replaceAll("_", " ")}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </article>
                ))}
            </div>
          </section>
        ))}
      </div>
      {!groups.length ? (
        <p className="p-6 text-sm text-dx-muted">No records yet.</p>
      ) : null}
    </div>
  );
}
export function TimelineView({
  widget,
  data,
}: {
  widget: RuntimeWidget;
  data?: WidgetData;
}) {
  // Null-safe outside the member runtime (admin builder preview).
  const selection = useContext(RecordSelection);
  const select = selection?.select;
  const date = widget.columns?.[1] || "createdAt";
  const rows = [...(data?.rows || [])].sort((a, b) =>
    String(a[date] || "").localeCompare(String(b[date] || "")),
  );
  return (
    <ol className="ml-2 space-y-6 border-l border-dx-line pl-5">
      {rows.map((row) => (
        <li key={String(row.id)} className="relative">
          <span className="absolute -left-[25px] top-1 h-2 w-2 rounded-full bg-teal-500" />
          <p className="text-[10px] text-dx-muted">{safeCellText(row[date])}</p>
          <button
            className="mt-1 text-sm font-semibold hover:text-teal-600"
            onClick={() => select?.(widget.resource || "", row)}
          >
            {safeCellText(row[widget.columns?.[0] || "title"])}
          </button>
          <p className="mt-1 text-xs text-dx-muted">
            {widget.columns
              ?.slice(2)
              .map((key) => safeCellText(row[key]))
              .join(" · ")}
          </p>
        </li>
      ))}
      {!rows.length ? (
        <li className="text-sm text-dx-muted">No timeline entries yet.</li>
      ) : null}
    </ol>
  );
}
/** Escaped React text nodes only; no HTML or executable URLs. */
export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="space-y-3 text-sm leading-7">
      {text.split("\n").map((line, index) =>
        line.startsWith("### ") ? (
          <h4 key={index} className="text-base font-semibold">
            {line.slice(4)}
          </h4>
        ) : line.startsWith("## ") ? (
          <h3 key={index} className="text-lg font-semibold">
            {line.slice(3)}
          </h3>
        ) : line.startsWith("# ") ? (
          <h2 key={index} className="text-2xl font-semibold">
            {line.slice(2)}
          </h2>
        ) : line.startsWith("- ") ? (
          <p className="pl-4" key={index}>
            • {line.slice(2)}
          </p>
        ) : (
          <p key={index} className="whitespace-pre-wrap">
            {line || "\u00a0"}
          </p>
        ),
      )}
    </div>
  );
}
