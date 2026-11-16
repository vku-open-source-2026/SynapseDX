// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense, useEffect, useState } from "react";
import { Plus, Braces, ListTree, Trash2 } from "lucide-react";
import { Button, inputClassName, selectClassName } from "../ui";
import { geometryError } from "../../lib/geometry";
import type { WorkspaceField } from "../../lib/workspaces";
const GeometryField = lazy(() => import("./GeometryField").then(m => ({ default: m.GeometryField })));
const object = (value: any): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const safeName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) && !["__proto__", "prototype", "constructor"].includes(name);
function NameInput({ name, label, rename }: { name: string; label: string; rename: (name: string) => boolean }) {
  const [draft, setDraft] = useState(name), [error, setError] = useState("");
  return <div><input aria-label={label} className={inputClassName} value={draft} maxLength={64} onChange={e => { setDraft(e.target.value); setError(""); }} onBlur={() => { if (draft !== name && !rename(draft)) { setDraft(name); setError("Choose a unique field name"); } }} />{error && <p role="alert" className="mt-1 text-xs text-rose-600">{error}</p>}</div>;
}
export function StructuredJsonField({ field, id, value, onChange }: { field: WorkspaceField; id: string; value: string; onChange: (value: string) => void }) {
  const [mode, setMode] = useState<"visual" | "json">("visual");
  let parsed: Record<string, any> = {}, error = "";
  try { const v = value.trim() ? JSON.parse(value) : {}; if (!object(v)) throw new Error("Enter a JSON object"); parsed = v; }
  catch (e) { error = (e as Error).message; }
  if (!error && value.trim() && field.editor === "geometry") error = geometryError(parsed) || "";
  const update = (next: Record<string, any>) => onChange(JSON.stringify(next, null, 2));
  const editable = !error || field.editor === "geometry";
  return <div className="overflow-hidden rounded-xl border border-dx-line bg-dx-surface">
    <div className="flex items-center justify-between border-b border-dx-line bg-dx-subtle/50 p-2"><span className="px-2 text-xs font-medium text-dx-muted">{field.editor === "schema" ? "Form schema" : field.editor === "query" ? "Report query" : "Geometry"}</span><div className="flex gap-1" role="tablist" aria-label={`${field.label} editor`}>
      {(["visual", "json"] as const).map(tab => <button type="button" key={tab} role="tab" aria-selected={mode === tab} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs ${mode === tab ? "bg-dx-surface font-semibold shadow-sm" : "text-dx-muted"}`} onClick={() => setMode(tab)}>{tab === "visual" ? <ListTree size={13} /> : <Braces size={13} />}{tab === "visual" ? "Visual" : "JSON"}</button>)}
    </div></div>
    <div className="p-3">{mode === "json" || !editable ? <textarea id={id} name={field.name} aria-label={field.label} className={inputClassName + " min-h-48 font-mono text-xs"} value={value} maxLength={50000} onChange={e => onChange(e.target.value)} spellCheck={false} /> :
      field.editor === "geometry" ? <Suspense fallback={<p className="p-4 text-xs text-dx-muted">Loading geometry editor…</p>}><GeometryField label={field.label} value={value} onChange={onChange} /></Suspense> :
      field.editor === "schema" ? <SchemaDesigner schema={parsed} update={update} /> : <QueryDesigner query={parsed} update={update} />}
      {error && <p role="alert" className="mt-2 text-xs text-rose-600">{error}</p>}
    </div>
  </div>;
}
function SchemaDesigner({ schema, update }: { schema: Record<string, any>; update: (value: Record<string, any>) => void }) {
  const properties = object(schema.properties) ? schema.properties : {}, required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const patch = (name: string, next: Record<string, any>) => update({ ...schema, type: "object", properties: { ...properties, [name]: { ...properties[name], ...next } } });
  const remove = (name: string) => { const next = { ...properties }; delete next[name]; update({ ...schema, properties: next, required: required.filter(n => n !== name) }); };
  const rename = (name: string, next: string) => { if (!safeName(next) || Object.hasOwn(properties, next)) return false; const entries = Object.entries(properties).map(([key, value]) => [key === name ? next : key, value]); update({ ...schema, properties: Object.fromEntries(entries), required: required.map(n => n === name ? next : n) }); return true; };
  return <div className="space-y-3"><p className="text-xs leading-5 text-dx-muted">Design fields and validation. Advanced keywords and nested schemas remain available in JSON.</p>
    <label className="block text-xs">Form title<input aria-label="Schema title" className={inputClassName + " mt-1"} value={schema.title || ""} onChange={e => update({ ...schema, title: e.target.value })} /></label>
    {Object.entries(properties).map(([name, spec]) => !object(spec) ? <div key={name} className="rounded-lg border border-dx-line p-3 text-xs"><p className="font-medium">{name}</p><p className="mt-1 text-dx-muted">This field uses an advanced schema. Edit its definition in JSON.</p><Button type="button" onClick={() => remove(name)}>Remove field</Button></div> : <div key={name} className="space-y-2 rounded-lg border border-dx-line bg-dx-subtle/30 p-3">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(80px,120px)_auto] items-start gap-2"><NameInput name={name} label={`Schema field ${name}`} rename={next => rename(name, next)} /><select aria-label={`Type of ${name}`} className={selectClassName} value={spec.type || "string"} onChange={e => patch(name, { type: e.target.value })}>{["string", "number", "integer", "boolean", "object", "array"].map(type => <option key={type}>{type}</option>)}</select><button type="button" aria-label={`Remove schema field ${name}`} className="p-2 text-rose-500" onClick={() => remove(name)}><Trash2 size={15} /></button></div>
      <div className="grid gap-2 sm:grid-cols-2"><label className="text-xs">Label<input aria-label={`Label of ${name}`} className={inputClassName + " mt-1"} value={spec.title || ""} onChange={e => patch(name, { title: e.target.value })} /></label><label className="text-xs">Choices (one per line)<textarea aria-label={`Choices for ${name}`} className={inputClassName + " mt-1"} rows={2} value={Array.isArray(spec.enum) ? spec.enum.join("\n") : ""} onChange={e => patch(name, { enum: e.target.value ? e.target.value.split("\n").map(value => { if (spec.type === "string" || !spec.type) return value; try { return JSON.parse(value); } catch { return value; } }) : undefined })} /></label></div>
      <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={required.includes(name)} onChange={e => update({ ...schema, required: e.target.checked ? [...required.filter(n => n !== name), name] : required.filter(n => n !== name) })} />Required</label>
        {spec.type === "string" && <select aria-label={`Format of ${name}`} className={selectClassName + " max-w-40"} value={spec.format || ""} onChange={e => patch(name, { format: e.target.value || undefined })}><option value="">Any text</option>{["email", "date", "date-time", "uri"].map(f => <option key={f}>{f}</option>)}</select>}
        {["number", "integer"].includes(spec.type) && ["minimum", "maximum"].map(bound => <input key={bound} aria-label={`${bound} for ${name}`} className={inputClassName + " max-w-32"} type="number" placeholder={bound} value={spec[bound] ?? ""} onChange={e => patch(name, { [bound]: e.target.value === "" ? undefined : Number(e.target.value) })} />)}
      </div>
    </div>)}
    <Button type="button" disabled={Object.keys(properties).length >= 100} onClick={() => { let n = 1; while (Object.hasOwn(properties, `field_${n}`)) n++; patch(`field_${n}`, { type: "string", title: `Field ${n}` }); }}><Plus size={14} />Add schema field</Button>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={schema.additionalProperties !== false} onChange={e => update({ ...schema, additionalProperties: e.target.checked })} />Allow additional fields</label>
  </div>;
}
function QueryDesigner({ query, update }: { query: Record<string, any>; update: (value: Record<string, any>) => void }) {
  const where = object(query.where) ? query.where : {};
  const patchWhere = (name: string, value: unknown) => update({ ...query, where: { ...where, [name]: value } });
  return <div className="space-y-3"><p className="text-xs leading-5 text-dx-muted">The report uses its authorized dataset. Filters match exact values; dotted names address nested fields.</p>
    <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs">Aggregation<select aria-label="Query aggregation" className={selectClassName + " mt-1"} value={query.aggregate || "count"} onChange={e => update({ ...query, aggregate: e.target.value })}><option value="count">Count records</option><option value="sum">Sum</option><option value="avg">Average</option></select></label>
      <label className="text-xs">Value field<input aria-label="Query value field" className={inputClassName + " mt-1"} value={query.field || ""} onChange={e => update({ ...query, field: e.target.value })} placeholder="amount" /></label>
      <label className="text-xs">Group by<input aria-label="Query group field" className={inputClassName + " mt-1"} value={query.groupBy || ""} onChange={e => update({ ...query, groupBy: e.target.value })} placeholder="createdAt" /></label>
      <label className="text-xs">Result limit<input aria-label="Query result limit" className={inputClassName + " mt-1"} type="number" min={1} max={5000} value={query.limit ?? 100} onChange={e => update({ ...query, limit: Number(e.target.value) })} /></label>
    </div><p className="pt-1 text-xs font-semibold">Filters</p>
    {Object.entries(where).map(([name, value]) => <div key={name} className="space-y-2 rounded-lg border border-dx-line p-2"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><NameInput name={name} label={`Filter field ${name}`} rename={key => { if (!key || !key.split('.').every(safeName) || Object.hasOwn(where, key)) return false; update({ ...query, where: Object.fromEntries(Object.entries(where).map(([k, v]) => [k === name ? key : k, v])) }); return true; }} /></div><button type="button" aria-label={`Remove filter ${name}`} className="p-2 text-rose-500" onClick={() => { const next = { ...where }; delete next[name]; update({ ...query, where: next }); }}><Trash2 size={15} /></button></div><FilterValue name={name} value={value} update={next => patchWhere(name, next)} /></div>)}
    <Button type="button" disabled={Object.keys(where).length >= 30} onClick={() => { let n = 1; while (Object.hasOwn(where, `filter_${n}`)) n++; patchWhere(`filter_${n}`, ""); }}><Plus size={14} />Add filter</Button>
  </div>;
}

function FilterValue({ name, value, update }: { name: string; value: unknown; update: (value: unknown) => void }) {
  const type = value === null ? "null" : typeof value;
  const [draft, setDraft] = useState(String(value ?? ""));
  useEffect(() => setDraft(String(value ?? "")), [value]);
  return <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-2">
    <select aria-label={`Filter type ${name}`} className={selectClassName} value={type} onChange={e => update(e.target.value === "null" ? null : e.target.value === "boolean" ? value === true || value === "true" : e.target.value === "number" ? Number.isFinite(Number(value)) ? Number(value) : 0 : String(value ?? ""))}>
      <option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="null">Null</option>{type === "object" && <option value="object">Advanced JSON</option>}
    </select>
    {type === "boolean" ? <select aria-label={`Filter value ${name}`} className={selectClassName} value={String(value)} onChange={e => update(e.target.value === "true")}><option value="true">true</option><option value="false">false</option></select> :
      <input aria-label={`Filter value ${name}`} className={inputClassName} disabled={type === "null" || type === "object"} value={type === "object" ? JSON.stringify(value) : draft} inputMode={type === "number" ? "decimal" : undefined} onChange={e => { const next = e.target.value; setDraft(next); if (type !== "number") update(next); else if (next.trim() && Number.isFinite(Number(next))) update(Number(next)); }} onBlur={() => setDraft(String(value ?? ""))} />}
  </div>;
}
