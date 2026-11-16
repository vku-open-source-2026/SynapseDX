// SPDX-License-Identifier: Apache-2.0
/** Reusable file preview, typed CSV mapping/import and generated table artifacts. */
import type { Express } from "express";
import { createHash } from "node:crypto";
import { isMachineCredential, isTenantAdmin } from "../auth";
import type { ServiceConfig } from "../config";
import { apiError } from "../errors";
import { handler } from "../http";
import { callCommon } from "../common-builder";
import { parseCsv, mapCsv, validateTabularSchema, tableExpression, csvCell } from "../tabular";
import { loadFile, readFileBytes, saveGeneratedFile } from "./files";
import { authenticatedReadContext, writeContext } from "./shared";

export function registerTabularFileRoutes(app: Express, config: ServiceConfig): void {
  const base = "/v1/capabilities/files";
  app.post(`${base}/:id/tabular/preview`, handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const found = await loadFile(client, String(req.params.id), { principal });
    if (!found.data.checksumSha256) throw apiError(409, "upload_incomplete", "Complete the file upload first");
    const bytes = await readFileBytes(client, config, found);
    let csv, mapped;
    try {
      csv = parseCsv(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (req.body?.schema) mapped = mapCsv(csv, req.body.schema);
    } catch (error) { throw apiError(400, "invalid_request", (error as Error).message); }
    res.json({ columns: csv.headers, rows: csv.rows.slice(0, 20), total: csv.rows.length, ...(mapped ? { validRows: mapped.records.length, invalidRows: mapped.errors.length, errors: mapped.errors.slice(0, 200) } : {}), checksumSha256: found.data.checksumSha256 });
  }));
  app.post(`${base}/:id/tabular/import`, handler(async (req, res) => {
    const { principal, caller, client } = await writeContext(req, config);
    if (!isMachineCredential(principal) && !isTenantAdmin(principal)) throw apiError(403, "forbidden", "Imports must use a reviewed workflow or organization administration");
    const product = principal.workspaceApp;
    if (product !== "city" && product !== "sos") throw apiError(400, "invalid_request", "Declare the destination app");
    const body = req.body || {};
    if (Object.keys(body).some(k => !["datasetId", "schema", "publish", "offset", "limit"].includes(k)) || typeof body.datasetId !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(body.datasetId)) throw apiError(400, "invalid_request", "Invalid import destination");
    if (!body.datasetId.startsWith(product === "city" ? "city-" : "sos-")) throw apiError(403, "forbidden", "Import destination belongs to another app");
    if (body.publish !== undefined && typeof body.publish !== "boolean") throw apiError(400, "invalid_request", "publish must be boolean");
    const offset = body.offset ?? 0, limit = body.limit ?? 500;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw apiError(400, "invalid_request", "Import batches support 1..500 rows and a nonnegative offset");
    try { validateTabularSchema(body.schema); } catch (error) { throw apiError(400, "invalid_request", (error as Error).message); }
    const found = await loadFile(client, String(req.params.id), { principal });
    if (!found.data.checksumSha256) throw apiError(409, "upload_incomplete", "Complete the file upload first");
    const bytes = await readFileBytes(client, config, found);
    let mapped;
    try { mapped = mapCsv(parseCsv(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), body.schema); }
    catch (error) { throw apiError(400, "invalid_request", (error as Error).message); }
    if (offset > mapped.total) throw apiError(400, "invalid_request", "Resume offset exceeds the file's row count");
    const end = Math.min(mapped.total, offset + limit);
    const records = mapped.records.filter(row => row.row >= offset + 2 && row.row < end + 2);
    const errors = mapped.errors.filter(row => row.row >= offset + 2 && row.row < end + 2);
    let imported = 0, skipped = 0;
    // Public capability calls keep ordinary record ACL, audit, publication and events.
    for (let index = 0; index < records.length; index += 100) {
      const batch = records.slice(index, index + 100);
      const result = await callCommon(config, caller.credential, product, `datasets/${body.datasetId}/records/bulk`, "POST", { records: batch.map(row => ({ id: row.id || `csv-${createHash("sha256").update(`${body.datasetId}:${found.data.checksumSha256}:${row.row}`).digest("hex").slice(0, 48)}`, data: row.data, publish: body.publish === true })) }, [400]);
      if (!Array.isArray(result.created) || !Array.isArray(result.errors)) throw apiError(502, "capability_failed", "Invalid record batch result");
      imported += result.created.length;
      for (const error of result.errors || []) {
        const row = batch[error.index];
        if (error.code === "record_already_exists" && row) {
          const id = row.id || `csv-${createHash("sha256").update(`${body.datasetId}:${found.data.checksumSha256}:${row.row}`).digest("hex").slice(0, 48)}`;
          // A global ID conflict in another dataset must not count as a skipped row.
          await callCommon(config, caller.credential, product, `datasets/${body.datasetId}/records/${encodeURIComponent(id)}`);
          skipped++;
        } else errors.push({ row: row?.row || offset + 2, message: String(error.message || error.code) });
      }
    }
    res.json({ totalRows: mapped.total, processedRows: end - offset, imported, skipped, invalid: errors.length, errors: errors.slice(0, 200), offset, ...(end < mapped.total ? { nextOffset: end } : {}), checksumSha256: found.data.checksumSha256, filename: found.data.filename });
  }));
  app.post(`${base}/tabular/export`, handler(async (req, res) => {
    const { principal, caller, client } = await writeContext(req, config);
    const product = principal.workspaceApp;
    if (product !== "city" && product !== "sos") throw apiError(400, "invalid_request", "Declare the destination app");
    const { datasetId, filename, format, columns, where, metadata } = req.body || {};
    if (typeof datasetId !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(datasetId) || !datasetId.startsWith(product === "city" ? "city-" : "sos-")) throw apiError(400, "invalid_request", "Choose a dataset in this app");
    if (!["csv", "json"].includes(format) || !Array.isArray(columns) || !columns.length || columns.length > 100 || columns.some(c => !c || typeof c.name !== "string" || c.name.length > 200)) throw apiError(400, "invalid_request", "Declare CSV/JSON columns");
    const now = new Date().toISOString(), rows: Record<string, unknown>[] = [];
    try { for (const column of columns) tableExpression(column.value, {}, now); } catch (error) { throw apiError(400, "invalid_request", (error as Error).message); }
    const pageSize = Math.min(config.maxPageSize, 500);
    for (let offset = 0; offset <= 50000; offset += pageSize) {
      const page = await callCommon(config, caller.credential, product, `datasets/${datasetId}/records/query`, "POST", { limit: pageSize, offset, ...(where ? { where } : {}), orderBy: "id:asc" });
      if (page.total > 50000 || rows.length + page.items.length > 50000) throw apiError(422, "capability_failed", "Report exceeds 50000 rows; narrow its filters");
      for (const record of page.items) {
        const source = { ...record.data, id: record.id }, row: Record<string, unknown> = {};
        for (const column of columns) row[column.name] = tableExpression(column.value, source, now);
        rows.push(row);
      }
      if (page.items.length < pageSize || rows.length >= page.total) break;
    }
    const names = columns.map(c => c.name);
    const content = format === "csv" ? [names.map(csvCell).join(","), ...rows.map(row => names.map(c => csvCell(row[c])).join(","))].join("\r\n") + "\r\n" : JSON.stringify({ metadata, generatedAt: now, rowCount: rows.length, rows }, null, 2) + "\n";
    const file = await saveGeneratedFile(client, config, principal, filename, format === "csv" ? "text/csv" : "application/json", Buffer.from(content));
    res.status(201).json({ ...file, file_id: file.id, rowCount: rows.length, generatedAt: now });
  }));
  app.post(`${base}/tabular/render`, handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { filename, format, columns, rows, metadata } = req.body || {};
    if (!["csv", "json"].includes(format)) throw apiError(415, "file_type_not_allowed", "Generated tables support CSV or JSON");
    if (!Array.isArray(columns) || !columns.length || columns.length > 100 || columns.some(c => typeof c !== "string" || c.length > 200) || !Array.isArray(rows) || rows.length > 50000 || rows.some(r => !r || typeof r !== "object" || Array.isArray(r))) throw apiError(400, "invalid_request", "Declare table columns and object rows");
    const content = format === "csv" ? [columns.map(csvCell).join(","), ...rows.map(row => columns.map(c => csvCell(row[c])).join(","))].join("\r\n") + "\r\n" : JSON.stringify({ metadata, rowCount: rows.length, columns, rows }, null, 2) + "\n";
    const file = await saveGeneratedFile(client, config, principal, filename, format === "csv" ? "text/csv" : "application/json", Buffer.from(content));
    res.status(201).json({ ...file, file_id: file.id, rowCount: rows.length });
  }));
}
