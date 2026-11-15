// SPDX-License-Identifier: Apache-2.0
/** Strict UTF-8 CSV parsing and declarative column mapping, independent of products. */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  text = text.replace(/^\uFEFF/, "");
  const records: string[][] = []; let row: string[] = [], value = "", quoted = false, closed = false;
  const field = () => { row.push(value); value = ""; closed = false; };
  const finish = () => { field(); if (row.some(v => v.trim())) records.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } }
      else value += c;
    } else if (c === '"') {
      if (value || closed) throw new Error("Unexpected quote in CSV field"); quoted = true;
    } else if (c === ",") field();
    else if (c === "\r" || c === "\n") { if (c === "\r" && text[i + 1] === "\n") i++; finish(); }
    else { if (closed && c.trim()) throw new Error("Unexpected text after CSV quote"); if (!closed) value += c; }
    if (records.length > 50001 || row.length > 200 || value.length > 100000) throw new Error("CSV exceeds 50000 rows, 200 columns or 100000 characters per field");
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  if (value || row.length || closed) finish();
  if (!records.length) throw new Error("CSV is empty");
  const headers = records.shift()!.map(v => v.trim().toLowerCase());
  if (headers.some(v => !v) || new Set(headers).size !== headers.length) throw new Error("CSV headers must be nonempty and unique");
  if (records.some(row => row.length !== headers.length)) throw new Error("CSV rows must have the same number of columns as the header");
  return { headers, rows: records };
}
export interface TabularColumn { column: string; field: string; type?: "text" | "number" | "boolean" | "json" | "date"; required?: boolean; min?: number; max?: number; maxLength?: number; options?: string[] }
export interface TabularSchema { columns: TabularColumn[]; defaults?: Record<string, unknown>; idField?: string; point?: { longitude: string; latitude: string; target: string } }
const safePath = (value: unknown): value is string => typeof value === "string" && value.length <= 200 && value.split(".").length <= 6 && value.split(".").every(v => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v) && !["__proto__", "prototype", "constructor"].includes(v));
export function validateTabularSchema(value: any): asserts value is TabularSchema {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !["columns", "defaults", "idField", "point"].includes(k)) || !Array.isArray(value.columns) || !value.columns.length || value.columns.length > 80) throw new Error("Declare 1..80 column mappings");
  const fields = new Set();
  for (const c of value.columns) {
    if (!c || Object.keys(c).some(k => !["column", "field", "type", "required", "min", "max", "maxLength", "options"].includes(k)) || typeof c.column !== "string" || c.column.length > 200 || !safePath(c.field) || fields.has(c.field)) throw new Error("Invalid or duplicate column mapping");
    fields.add(c.field);
    if (c.type && !["text", "number", "boolean", "json", "date"].includes(c.type)) throw new Error("Invalid column type");
    if (c.required !== undefined && typeof c.required !== "boolean") throw new Error("Invalid required setting");
    for (const key of ["min", "max", "maxLength"]) if (c[key] !== undefined && (typeof c[key] !== "number" || !Number.isFinite(c[key]))) throw new Error("Invalid column limit");
    if (c.options && (!Array.isArray(c.options) || c.options.length > 100 || c.options.some((v: any) => typeof v !== "string"))) throw new Error("Invalid column options");
  }
  if (value.idField && !safePath(value.idField)) throw new Error("Invalid ID field");
  if (value.point && (!["longitude", "latitude", "target"].every(k => safePath(value.point[k])) || Object.keys(value.point).some(k => !["longitude", "latitude", "target"].includes(k)))) throw new Error("Invalid point mapping");
  if (value.defaults && (typeof value.defaults !== "object" || Array.isArray(value.defaults) || JSON.stringify(value.defaults).length > 20000)) throw new Error("Invalid default data");
  const check = (obj: any) => { if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) { if (["__proto__", "prototype", "constructor"].includes(k)) throw new Error("Unsafe default key"); check(v); } };
  check(value.defaults);
}
export function tabularValue(row: Record<string, any>, path: string): any { return path.split(".").reduce((v, key) => v?.[key], row); }
function assign(row: Record<string, any>, path: string, value: any): void {
  const parts = path.split("."); let item = row;
  for (const key of parts.slice(0, -1)) { if (!item[key] || typeof item[key] !== "object" || Array.isArray(item[key])) item[key] = {}; item = item[key]; }
  item[parts.at(-1)!] = value;
}
export function mapCsv(csv: ReturnType<typeof parseCsv>, schema: TabularSchema) {
  validateTabularSchema(schema);
  for (const c of schema.columns) if (c.required && !csv.headers.includes(c.column.toLowerCase())) throw new Error(`Missing required column: ${c.column}`);
  const errors: { row: number; message: string }[] = [], records: { row: number; id?: string; data: Record<string, any> }[] = [];
  csv.rows.forEach((values, index) => {
    try {
      const data = JSON.parse(JSON.stringify(schema.defaults || {}));
      for (const column of schema.columns) {
        const raw = (values[csv.headers.indexOf(column.column.toLowerCase())] || "").trim();
        if (!raw) { if (column.required) throw new Error(`${column.column} is required`); continue; }
        if (raw.length > (column.maxLength ?? 4000)) throw new Error(`${column.column} is too long`);
        let value: any = raw;
        if (column.type === "number") { value = Number(raw); if (!Number.isFinite(value) || value < (column.min ?? -Infinity) || value > (column.max ?? Infinity)) throw new Error(`${column.column} must be a number in range`); }
        if (column.type === "boolean") { if (!["true", "false", "1", "0"].includes(raw)) throw new Error(`${column.column} must be true or false`); value = raw === "true" || raw === "1"; }
        if (column.type === "json") { try { value = JSON.parse(raw); } catch { throw new Error(`${column.column} must contain valid JSON`); } }
        if (column.type === "date") { if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new Error(`${column.column} must contain a date`); value = new Date(raw).toISOString(); }
        if (column.options && !column.options.includes(String(value))) throw new Error(`${column.column} has an invalid option`);
        assign(data, column.field, value);
      }
      if (schema.point) {
        const lng = tabularValue(data, schema.point.longitude), lat = tabularValue(data, schema.point.latitude);
        if (typeof lng !== "number" || Math.abs(lng) > 180 || typeof lat !== "number" || Math.abs(lat) > 90) throw new Error("Invalid geographic coordinates");
        if (!tabularValue(data, schema.point.target)) assign(data, schema.point.target, { type: "Point", coordinates: [lng, lat] });
      }
      const id = schema.idField ? tabularValue(data, schema.idField) : undefined;
      if (id !== undefined && (typeof id !== "string" || !/^[A-Za-z0-9_@.:+-]{1,256}$/.test(id))) throw new Error("Invalid record ID");
      records.push({ row: index + 2, ...(id ? { id } : {}), data });
    } catch (error) { errors.push({ row: index + 2, message: (error as Error).message }); }
  });
  return { records, errors, total: csv.rows.length };
}
export function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

/** Small bounded expression tree for portable calculated export columns; no eval or code execution. */
export function tableExpression(expr: any, row: Record<string, unknown>, now: string, depth = 0): any {
  if (depth > 10 || !expr || typeof expr !== "object" || Array.isArray(expr)) throw new Error("Invalid calculated column expression");
  if (Object.prototype.hasOwnProperty.call(expr, "literal")) return expr.literal;
  if (Object.prototype.hasOwnProperty.call(expr, "field")) { if (!safePath(expr.field)) throw new Error("Unsafe export field"); return tabularValue(row, expr.field) ?? null; }
  const args = expr.args || [];
  if (!Array.isArray(args) || args.length > 12) throw new Error("Invalid expression arguments");
  const values = args.map((arg: any) => tableExpression(arg, row, now, depth + 1));
  if (expr.op === "now") return now;
  if (expr.op === "coalesce") return values.find((v: any) => v !== undefined && v !== null && v !== "") ?? null;
  if (expr.op === "number") { const v = values[0]; return v === null || v === "" || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v); }
  if (expr.op === "year") { const date = new Date(values[0]); return values[0] && Number.isFinite(date.getTime()) ? date.getUTCFullYear() : null; }
  if (expr.op === "yearsBetween") { const a = Date.parse(values[0]), b = Date.parse(values[1]); return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / (365.25 * 86400000) : null; }
  if (values.some((v: any) => v === null || v === undefined || !Number.isFinite(Number(v)))) return null;
  const n = values.map(Number);
  switch (expr.op) {
    case "add": return n.reduce((a: number, b: number) => a + b, 0);
    case "subtract": return n[0] - n[1];
    case "multiply": return n.reduce((a: number, b: number) => a * b, 1);
    case "divide": return n[1] ? n[0] / n[1] : null;
    case "max": return n.length ? Math.max(...n) : null;
    case "min": return n.length ? Math.min(...n) : null;
    case "ceil": return Math.ceil(n[0]);
    case "round": return Math.round(n[0] * 10 ** (n[1] || 0)) / 10 ** (n[1] || 0);
    default: throw new Error("Unknown calculated column operation");
  }
}
