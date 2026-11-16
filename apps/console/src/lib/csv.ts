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
