// SPDX-License-Identifier: Apache-2.0
import { useContext, useState, useRef } from "react";
import { FileUp, CheckCircle2, Loader2 } from "lucide-react";
import { WorkspaceActions } from "./WorkspaceActions";
import type { WorkspaceField } from "../../lib/workspaces";
import { parseCsv } from "../../lib/csv";
import { Button } from "../ui";

/** Selecting bytes is local; only the published upload action can transfer them. */
export function FileField({ field, id, value, onChange, enabled }: {
  field: WorkspaceField; id: string; value: string; onChange: (value: string) => void; enabled: boolean;
}) {
  const actions = useContext(WorkspaceActions);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [csv, setCsv] = useState<ReturnType<typeof parseCsv> | null>(null);
  const selection = useRef(0);
  const upload = async () => {
    if (!file || !actions || !field.uploadAction) return;
    setBusy(true); setError("");
    try {
      const result = await actions.run(field.uploadAction, { file }, { silent: true }) as { id: string };
      onChange(result.id);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3 rounded-xl border border-dashed border-dx-line bg-dx-subtle/40 p-4">
    <input id={id} aria-label={field.label} type="file" accept={field.accept} disabled={busy || !enabled}
      className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-teal-50 file:px-3 file:py-2 file:text-teal-800"
      onChange={async event => {
        const next = event.target.files?.[0] || null;
        const version = ++selection.current;
        onChange(""); setError(""); setFile(next); setCsv(null); setInvalid(false);
        if (next && next.size > (field.maxBytes || 10485760)) { setError("File exceeds this field’s size limit."); setInvalid(true); return; }
        if (next && (next.type === "text/csv" || next.name.toLowerCase().endsWith(".csv"))) {
          try { const parsed = parseCsv(await next.text()); if (selection.current === version) setCsv(parsed); }
          catch (error) { if (selection.current === version) { setError((error as Error).message); setInvalid(true); } }
        }
      }} />
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-xs text-dx-muted">{field.accept || "All file types"} · up to {Math.round((field.maxBytes || 10485760) / 1048576 * 10) / 10} MB</span>
      {value ? <span role="status" className="inline-flex items-center gap-1 text-xs text-teal-700"><CheckCircle2 size={14} /> Uploaded{file ? ` · ${file.name}` : ""}</span> :
      <Button type="button" disabled={!file || busy || invalid || !enabled || !field.uploadAction} onClick={() => void upload()}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />} {busy ? "Uploading…" : "Upload file"}
      </Button>}
    </div>
    {csv && <div className="overflow-auto rounded-lg border border-dx-line bg-dx-surface">
      <p className="px-3 py-2 text-xs text-dx-muted">CSV preview · {csv.rows.length} rows · {csv.headers.length} columns · showing first 5 rows</p>
      <table className="w-full text-left text-xs"><thead><tr>{csv.headers.slice(0, 10).map(header => <th key={header} className="border-t border-dx-line px-3 py-2">{header}</th>)}</tr></thead>
      <tbody>{csv.rows.slice(0, 5).map((row, index) => <tr key={index}>{row.slice(0, 10).map((cell, column) => <td key={column} className="max-w-48 truncate border-t border-dx-line px-3 py-2">{cell}</td>)}</tr>)}</tbody></table>
    </div>}
    {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
    {!field.uploadAction && <p className="text-xs text-amber-700">Choose an upload action in Studio.</p>}
  </div>;
}
