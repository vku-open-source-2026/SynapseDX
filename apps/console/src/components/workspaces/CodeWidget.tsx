// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, ModalError } from "../Modal";
import { Button } from "../ui";
import { executeFormWidget, fetchWidgetData } from "../../lib/workspacesApi";
import {
  studioCodeError,
  type RuntimeWidget,
  type StudioCode,
} from "../../lib/workspaces";

function encodedSize(value: unknown) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Infinity;
  }
}

export type StudioLog = { level: string; message: string };
type Request = {
  id: string;
  kind: "query" | "action";
  widgetId: string;
  values: Record<string, unknown>;
};
export function CodeWidget({
  code,
  title,
  installedId,
  widgets = [],
  cacheScope = "",
  previewData,
  actionId,
  onLog,
  onResult,
}: {
  actionId?: string;
  code: StudioCode;
  title: string;
  installedId?: string;
  widgets?: RuntimeWidget[];
  cacheScope?: string;
  previewData?: Record<string, unknown>;
  onLog?: (entry: StudioLog) => void;
  onResult?: (value: unknown) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [channel] = useState(() => crypto.randomUUID());
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Request | null>(null);
  const active = useRef<Request | null>(null);
  const [busy, setBusy] = useState(false),
    [confirmedDelete, setConfirmedDelete] = useState(false);
  const queryClient = useQueryClient();
  const logRef = useRef(onLog);
  logRef.current = onLog;
  const resultRef = useRef(onResult);
  resultRef.current = onResult;
  const reply = (id: string, result?: unknown, error?: string) =>
    frame.current?.contentWindow?.postMessage(
      { channel, type: "response", id, result, error },
      "*",
    );
  useEffect(() => {
    let disposed = false,
      count = 0,
      since = Date.now();
    const inflight = new Set<string>();
    const handle = async (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== "null"
      )
        return;
      const m = event.data;
      if (!m || typeof m !== "object" || m.channel !== channel) return;
      if (m.type === "log" && typeof m.message === "string") {
        const message = m.message.slice(0, 4000);
        logRef.current?.({ level: m.level, message });
        if (m.level === "error") setFailure(message);
        return;
      }
      if (m.type === "result" && encodedSize(m.value) <= 20000) {
        resultRef.current?.(m.value);
        return;
      }
      if (m.type === "cancel") {
        if (active.current?.id === m.id) {
          active.current = null;
          setConfirmation(null);
        }
        return;
      }
      if (
        m.type !== "request" ||
        typeof m.id !== "string" ||
        m.id.length > 20 ||
        inflight.has(m.id)
      )
        return;
      if (Date.now() - since > 60000) {
        count = 0;
        since = Date.now();
      }
      if (++count > 120 || inflight.size >= 10) {
        reply(m.id, undefined, "Studio call limit exceeded");
        return;
      }
      const binding =
        m.kind === "query"
          ? code.inputs
          : m.kind === "action"
            ? code.actions
            : [];
      if (!binding.includes(m.widgetId)) {
        reply(m.id, undefined, "This widget binding is not declared");
        return;
      }
      const values = m.values;
      if (
        !values ||
        typeof values !== "object" ||
        Array.isArray(values) ||
        encodedSize(values) > 20000
      ) {
        reply(m.id, undefined, "Expected a bounded values object");
        return;
      }
      if (previewData !== undefined) {
        logRef.current?.({
          level: "info",
          message: `${m.kind}(${m.widgetId}) · preview fixture`,
        });
        if (m.kind === "query" && !(m.widgetId in previewData))
          reply(m.id, undefined, `Add preview data for ${m.widgetId}`);
        else
          reply(
            m.id,
            m.kind === "query"
              ? previewData[m.widgetId]
              : { preview: true, widgetId: m.widgetId, values },
          );
        return;
      }
      const widget = widgets.find((w) => w.id === m.widgetId);
      if (!installedId || !widget) {
        reply(m.id, undefined, "Installed widget is unavailable");
        return;
      }
      if (m.kind === "action") {
        if (widget.type !== "form" || widget.canSubmit !== true) {
          reply(m.id, undefined, "This action is not authorized");
          return;
        }
        if (active.current) {
          reply(
            m.id,
            undefined,
            "Finish the current action confirmation first",
          );
          return;
        }
        active.current = m;
        setConfirmedDelete(false);
        setConfirmation(m);
        return;
      }
      inflight.add(m.id);
      try {
        if (
          ![
            "metric",
            "table",
            "chart",
            "list",
            "map",
            "kanban",
            "timeline",
          ].includes(widget.type)
        )
          throw new Error("Choose a data widget");
        if (
          Object.keys(values).some(
            (key) =>
              ![
                "limit",
                "offset",
                "search",
                "status",
                "sortBy",
                "sortDirection",
              ].includes(key),
          )
        )
          throw new Error(
            "Query supports pagination, search, status and sorting",
          );
        if (
          values.limit !== undefined &&
          (!Number.isInteger(values.limit) ||
            Number(values.limit) < 1 ||
            Number(values.limit) > 100)
        )
          throw new Error("Limit must be 1..100");
        if (
          values.offset !== undefined &&
          (!Number.isInteger(values.offset) ||
            Number(values.offset) < 0 ||
            Number(values.offset) > 100000)
        )
          throw new Error("Invalid offset");
        if (
          values.search !== undefined &&
          (typeof values.search !== "string" || values.search.length > 200)
        )
          throw new Error("Invalid search");
        const result = await queryClient.fetchQuery({
          queryKey: [
            "workspace-widget",
            cacheScope,
            installedId,
            widget.id,
            "code",
            actionId,
            values,
          ],
          queryFn: () => fetchWidgetData(installedId, widget, values, actionId),
        });
        if (!disposed) reply(m.id, result);
      } catch (error) {
        if (!disposed) reply(m.id, undefined, (error as Error).message);
      } finally {
        inflight.delete(m.id);
      }
    };
    window.addEventListener("message", handle);
    return () => {
      disposed = true;
      window.removeEventListener("message", handle);
    };
  }, [
    code,
    channel,
    installedId,
    widgets,
    cacheScope,
    actionId,
    previewData,
    queryClient,
  ]);
  const dismiss = () => {
    if (busy) return;
    if (active.current) reply(active.current.id, undefined, "Action cancelled");
    active.current = null;
    setConfirmation(null);
  };
  const action = widgets.find((w) => w.id === confirmation?.widgetId);
  const execute = async () => {
    if (
      !confirmation ||
      !installedId ||
      !action?.canSubmit ||
      busy ||
      (action.action === "delete" && !confirmedDelete)
    )
      return;
    setBusy(true);
    try {
      const result = await executeFormWidget(
        installedId,
        action.id,
        confirmation.values,
        actionId,
      );
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
      reply(confirmation.id, result);
    } catch (error) {
      reply(confirmation.id, undefined, (error as Error).message);
    } finally {
      active.current = null;
      setConfirmation(null);
      setBusy(false);
    }
  };
  const error = studioCodeError(code);
  if (error) return <ModalError message={error} />;
  return (
    <div className="space-y-2">
      <iframe
        ref={frame}
        title={`${title} code preview`}
        src="/studio-sandbox.html"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="w-full rounded-xl border border-dx-line bg-white"
        style={{ height: code.height }}
        onLoad={() =>
          frame.current?.contentWindow?.postMessage(
            { type: "init", channel, code },
            "*",
          )
        }
      />
      {failure ? <ModalError message={failure} /> : null}
      <Modal
        open={!!confirmation}
        title={`Confirm ${action?.title || "action"}`}
        eyebrow="Custom component request"
        onClose={dismiss}
        footer={
          <>
            <Button onClick={dismiss} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void execute()}
              disabled={
                busy || (action?.action === "delete" && !confirmedDelete)
              }
            >
              {busy ? "Running…" : "Confirm action"}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm">
          {action?.action} · {action?.resource}
        </p>
        <pre className="max-h-64 overflow-auto rounded-lg bg-dx-subtle p-3 text-xs">
          {JSON.stringify(confirmation?.values, null, 2)}
        </pre>
        {action?.action === "delete" ? (
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmedDelete}
              onChange={(e) => setConfirmedDelete(e.target.checked)}
            />
            I confirm this deletion
          </label>
        ) : null}
      </Modal>
    </div>
  );
}
