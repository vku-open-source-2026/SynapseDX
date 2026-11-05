// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * D-layer data products (#40) and reusable reports/dashboards (#39).
 * Dataset contracts, schema compatibility, quality rules, lineage and
 * permission-checked report execution with scheduled exports.
 */
import { createHash, createHmac, randomUUID } from 'crypto';
import { Express } from 'express';
import { isAdmin, canAccessDataset, hasWriteScope } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import {
  COLLECTIONS, correlationIdOf, getDocumentOrNull, queryDocuments, recordAudit,
} from '../platform';
import { loadDataset } from '../publication';
import { authenticatedReadContext, readContext, writeContext } from './shared';
import {
  createScoped, getScoped, listScoped, newId, nowIso, objectValue, optionalString,
  requiredString, stringArray, updateScoped,
} from './module-helpers';

interface ContractRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  datasetId: string; version: number; schema: Record<string, any>; semanticTypes: Record<string, string>;
  owner?: string; sla?: string; retentionDays?: number; license?: string;
  compatibility: 'backward' | 'forward' | 'full'; migration?: boolean;
}
interface QualityRuleRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  datasetId: string; rules: Array<Record<string, any>>; blockPublication: boolean;
}
interface QualityRunRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  datasetId: string; status: 'passed' | 'failed'; results: Array<Record<string, any>>; checked: number; failed: number;
}
interface LineageRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  from: { type: string; id: string }; to: { type: string; id: string }; relation: string;
}
interface ReportRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  name: string; description?: string; kind: string; datasetId?: string;
  query: Record<string, any>; parameters: string[];
  schedule?: { cron: string; format: 'csv' | 'json' | 'ndjson'; recipient?: string; enabled: boolean; lastRunAt?: string };
}
interface DashboardRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  name: string; widgets: Array<{ id: string; reportId: string; title?: string; x: number; y: number; w: number; h: number }>;
  filters: Record<string, any>; shareId?: string;
}
interface ReportRunRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  reportId: string; format: string; rowCount: number; content: string; idempotencyKey?: string;
}

function propsOf(schema: Record<string, any>): Record<string, any> {
  return schema?.properties && typeof schema.properties === 'object' ? schema.properties : schema;
}
function requiredOf(schema: Record<string, any>): string[] {
  return Array.isArray(schema?.required) ? schema.required.map(String) : [];
}

/** Compatibility check between the previous and next contract schema. */
export function checkSchemaCompatibility(previous: Record<string, any> | null, next: Record<string, any>, mode: string): { compatible: boolean; reason?: string } {
  if (!previous) return { compatible: true };
  const oldProps = propsOf(previous);
  const newProps = propsOf(next);
  const oldRequired = requiredOf(previous);
  const newRequired = requiredOf(next);
  if (mode === 'backward') {
    for (const key of oldRequired) {
      if (!(key in newProps)) return { compatible: false, reason: `required field '${key}' was removed` };
      if (oldProps[key]?.type && newProps[key]?.type && oldProps[key].type !== newProps[key].type) {
        return { compatible: false, reason: `field '${key}' changed type` };
      }
    }
  } else if (mode === 'forward') {
    for (const key of newRequired) {
      if (!(key in oldProps)) return { compatible: false, reason: `new required field '${key}' breaks old consumers` };
    }
  } else {
    const oldKeys = Object.keys(oldProps).sort();
    const newKeys = Object.keys(newProps).sort();
    if (oldKeys.join('|') !== newKeys.join('|')) return { compatible: false, reason: 'full compatibility requires an identical field set' };
    for (const key of oldKeys) {
      if (oldProps[key]?.type !== newProps[key]?.type) return { compatible: false, reason: `field '${key}' changed type` };
    }
    if (oldRequired.sort().join('|') !== newRequired.sort().join('|')) return { compatible: false, reason: 'full compatibility requires identical required fields' };
  }
  return { compatible: true };
}

/** Called by the dataset publish route. A failing quality run can block a
 *  publication when the tenant configured `blockPublication`. */
export async function assertDatasetPublishable(client: any, dataset: { id: string; tenant?: string }): Promise<void> {
  const rules = await queryDocuments<QualityRuleRecord>(client, COLLECTIONS.qualityRules, {
    where: { datasetId: dataset.id }, limit: 1,
  });
  const config = rules.items[0]?.data;
  if (!config?.blockPublication) return;
  const runs = await queryDocuments<QualityRunRecord>(client, COLLECTIONS.qualityRuns, {
    where: { datasetId: dataset.id }, orderBy: { field: 'createdAt', direction: 'desc' }, limit: 1,
  });
  const latest = runs.items[0]?.data;
  if (latest && latest.status === 'failed') {
    throw apiError(409, 'quality_gate_failed', 'quality rules are failing; fix the data or disable the publication gate', {
      failed: latest.failed, checked: latest.checked,
    });
  }
}

function evaluateRules(rules: Array<Record<string, any>>, records: Array<Record<string, any>>): Array<Record<string, any>> {
  const results: Array<Record<string, any>> = [];
  for (const rule of rules) {
    const type = String(rule.type || '');
    const field = String(rule.field || '');
    const values = records.map((record) => record[field]);
    let failed = 0;
    const examples: any[] = [];
    for (let index = 0; index < records.length; index++) {
      const value = values[index];
      let ok = true;
      if (type === 'required') ok = value !== undefined && value !== null && value !== '';
      else if (type === 'unique') ok = values.filter((item) => item === value).length === 1;
      else if (type === 'range') ok = typeof value === 'number' && (rule.min === undefined || value >= Number(rule.min)) && (rule.max === undefined || value <= Number(rule.max));
      else if (type === 'regex') {
        try { ok = typeof value === 'string' && new RegExp(String(rule.pattern || '.*')).test(value); } catch { ok = false; }
      } else if (type === 'freshness') {
        const at = new Date(String(value)).getTime();
        ok = Number.isFinite(at) && Date.now() - at <= Number(rule.maxAgeSeconds || 86400) * 1000;
      }
      if (!ok) {
        failed++;
        if (examples.length < 5) examples.push({ index, value });
      }
    }
    results.push({ name: String(rule.name || `${type}:${field}`), type, field, failed, passed: records.length - failed, examples });
  }
  return results;
}

function filterRecords(records: Array<Record<string, any>>, where: Record<string, any>): Array<Record<string, any>> {
  return records.filter((record) => Object.entries(where).every(([key, value]) => {
    if (key.includes('.')) {
      const actual = key.split('.').reduce((obj: any, part) => (obj == null ? undefined : obj[part]), record);
      return actual === value;
    }
    return record[key] === value;
  }));
}

function reportRows(report: ReportRecord, records: Array<Record<string, any>>, params: Record<string, any>): { rows: any[]; total: number } {
  const where = { ...(report.query.where || {}), ...params };
  const filtered = filterRecords(records, where);
  const field = report.query.field ? String(report.query.field) : '';
  if (report.kind === 'metric') {
    const op = String(report.query.aggregate || 'count');
    const value = op === 'count' ? filtered.length
      : filtered.reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
    return { rows: [{ value: op === 'avg' ? (filtered.length ? value / filtered.length : 0) : value, aggregate: op, field }], total: filtered.length };
  }
  if (report.kind === 'trend' || report.kind === 'line' || report.kind === 'bar') {
    const groupBy = String(report.query.groupBy || 'date');
    const buckets = new Map<string, { key: string; value: number; count: number }>();
    for (const row of filtered) {
      const key = String(row[groupBy] ?? '').slice(0, 10);
      const bucket = buckets.get(key) || { key, value: 0, count: 0 };
      bucket.value += Number(row[field]) || (field ? 0 : 1);
      bucket.count++;
      buckets.set(key, bucket);
    }
    return { rows: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)), total: filtered.length };
  }
  return { rows: filtered.slice(0, Math.min(Number(report.query.limit) || 100, 5000)), total: filtered.length };
}

function toCsv(rows: any[]): string {
  if (!rows.length) return '';
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value: any) => {
    const text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n');
}

export function registerDataInsightRoutes(app: Express, config: ServiceConfig): void {
  // ---------------- contracts ----------------
  app.post('/v1/capabilities/datasets/:id/contract', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const dataset = await loadDataset(client, String(req.params.id));
    if (!dataset || (!isAdmin(principal) && dataset.data.tenant !== principal.tenantKey)) throw apiError(404, 'dataset_not_found', 'dataset not found');
    const b = (req.body || {}) as Record<string, unknown>;
    const schema = objectValue(b.schema, 'schema', 200_000);
    if (!Object.keys(propsOf(schema)).length) throw apiError(400, 'invalid_request', 'schema.properties is required');
    const compatibility = ['backward', 'forward', 'full'].includes(String(b.compatibility)) ? String(b.compatibility) as any : 'backward';
    const previous = await queryDocuments<ContractRecord>(client, COLLECTIONS.contracts, {
      where: { datasetId: dataset.data.id }, orderBy: { field: 'version', direction: 'desc' }, limit: 1,
    });
    const previousContract = previous.items[0]?.data;
    const check = checkSchemaCompatibility(previousContract?.schema || null, schema, compatibility);
    if (!check.compatible && b.migration !== true) {
      throw apiError(409, 'incompatible_schema', check.reason || 'schema change is not compatible', {
        compatibility, previousVersion: previousContract?.version || 0,
      });
    }
    const contract = await createScoped(client, COLLECTIONS.contracts, principal, {
      datasetId: dataset.data.id, version: (previousContract?.version || 0) + 1,
      schema, semanticTypes: objectValue(b.semanticTypes, 'semanticTypes', 50_000),
      owner: optionalString(b.owner, 'owner', 200), sla: optionalString(b.sla, 'sla', 200),
      retentionDays: b.retentionDays === undefined ? dataset.data.retentionDays : Number(b.retentionDays),
      license: optionalString(b.license, 'license', 200) || dataset.data.license,
      compatibility, migration: b.migration === true,
    } as any) as unknown as ContractRecord;
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'data.contract.create',
      correlationId: correlationIdOf(req), details: { datasetId: dataset.data.id, version: contract.version, compatibility, migration: b.migration === true },
    });
    res.status(201).json({ contract, compatibility: check });
  }));

  app.get('/v1/capabilities/datasets/:id/contract', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const dataset = await loadDataset(client, String(req.params.id));
    if (!dataset || (!isAdmin(principal) && dataset.data.tenant !== principal.tenantKey)) throw apiError(404, 'dataset_not_found', 'dataset not found');
    const versions = await queryDocuments<ContractRecord>(client, COLLECTIONS.contracts, {
      where: { datasetId: dataset.data.id }, orderBy: { field: 'version', direction: 'desc' }, limit: 100,
    });
    res.json({ contract: versions.items[0]?.data || null, versions: versions.items.map((item) => item.data) });
  }));

  // ---------------- quality ----------------
  app.put('/v1/capabilities/datasets/:id/quality/rules', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const dataset = await loadDataset(client, String(req.params.id));
    if (!dataset || (!isAdmin(principal) && dataset.data.tenant !== principal.tenantKey)) throw apiError(404, 'dataset_not_found', 'dataset not found');
    const b = (req.body || {}) as Record<string, unknown>;
    const rules = Array.isArray(b.rules) ? b.rules.slice(0, 50) : [];
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object' || !['required', 'unique', 'range', 'regex', 'freshness'].includes(String(rule.type)) || !String(rule.field || '').trim()) {
        throw apiError(400, 'invalid_request', 'each rule needs type required|unique|range|regex|freshness and a field');
      }
    }
    const existing = await queryDocuments<QualityRuleRecord>(client, COLLECTIONS.qualityRules, { where: { datasetId: dataset.data.id }, limit: 1 });
    let saved: QualityRuleRecord;
    if (existing.items[0]) {
      saved = await updateScoped(client, COLLECTIONS.qualityRules, existing.items[0].id, principal, {
        rules, blockPublication: b.blockPublication === true,
      } as any);
    } else {
      saved = await createScoped(client, COLLECTIONS.qualityRules, principal, {
        datasetId: dataset.data.id, rules, blockPublication: b.blockPublication === true,
      } as any) as unknown as QualityRuleRecord;
    }
    res.json({ quality: saved });
  }));

  app.post('/v1/capabilities/datasets/:id/quality/run', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const dataset = await loadDataset(client, String(req.params.id));
    if (!dataset || (!isAdmin(principal) && dataset.data.tenant !== principal.tenantKey)) throw apiError(404, 'dataset_not_found', 'dataset not found');
    const rulesDoc = await queryDocuments<QualityRuleRecord>(client, COLLECTIONS.qualityRules, { where: { datasetId: dataset.data.id }, limit: 1 });
    const rules = rulesDoc.items[0]?.data.rules || [];
    const records = await queryDocuments<{ data: Record<string, any> }>(client, COLLECTIONS.records, {
      where: { datasetId: dataset.data.id }, limit: 5000,
    });
    const rows = records.items.map((item) => item.data?.data || {});
    const results = evaluateRules(rules, rows);
    const failed = results.reduce((sum, result) => sum + Number(result.failed || 0), 0);
    const run = await createScoped(client, COLLECTIONS.qualityRuns, principal, {
      datasetId: dataset.data.id, status: failed > 0 ? 'failed' : 'passed',
      results, checked: rows.length, failed,
    } as any) as unknown as QualityRunRecord;
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'data.quality.run',
      correlationId: correlationIdOf(req), details: { datasetId: dataset.data.id, failed, checked: rows.length },
    });
    res.status(201).json({ run });
  }));

  app.get('/v1/capabilities/datasets/:id/quality', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const dataset = await loadDataset(client, String(req.params.id));
    if (!dataset || (!isAdmin(principal) && dataset.data.tenant !== principal.tenantKey)) throw apiError(404, 'dataset_not_found', 'dataset not found');
    const rules = await queryDocuments<QualityRuleRecord>(client, COLLECTIONS.qualityRules, { where: { datasetId: dataset.data.id }, limit: 1 });
    const runs = await queryDocuments<QualityRunRecord>(client, COLLECTIONS.qualityRuns, {
      where: { datasetId: dataset.data.id }, orderBy: { field: 'createdAt', direction: 'desc' }, limit: 20,
    });
    res.json({ rules: rules.items[0]?.data || null, latest: runs.items[0]?.data || null, runs: runs.items.map((item) => item.data) });
  }));

  // ---------------- lineage ----------------
  app.post('/v1/capabilities/lineage', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const from = b.from as any; const to = b.to as any;
    if (!from?.type || !from?.id || !to?.type || !to?.id) throw apiError(400, 'invalid_request', 'from/to need type and id');
    const link = await createScoped(client, COLLECTIONS.lineage, principal, {
      from: { type: String(from.type).slice(0, 64), id: String(from.id).slice(0, 256) },
      to: { type: String(to.type).slice(0, 64), id: String(to.id).slice(0, 256) },
      relation: optionalString(b.relation, 'relation', 64) || 'derived_from',
    } as any) as unknown as LineageRecord;
    res.status(201).json({ link });
  }));

  app.get('/v1/capabilities/lineage/:type/:id', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const direction = String(req.query.direction || 'downstream');
    if (!['upstream', 'downstream'].includes(direction)) throw apiError(400, 'invalid_request', 'direction must be upstream or downstream');
    const depth = Math.min(Math.max(Number(req.query.depth) || 3, 1), 10);
    const all = await queryDocuments<LineageRecord>(client, COLLECTIONS.lineage, {
      where: isAdmin(principal) ? {} : { tenant: principal.tenantKey }, limit: 10_000,
    });
    const links = all.items.map((item) => item.data);
    const start = { type: String(req.params.type), id: String(req.params.id) };
    const nodes = new Map<string, { type: string; id: string; depth: number }>();
    nodes.set(`${start.type}:${start.id}`, { ...start, depth: 0 });
    let frontier = [start];
    for (let level = 1; level <= depth; level++) {
      const next: Array<{ type: string; id: string }> = [];
      for (const node of frontier) {
        for (const link of links) {
          const matches = direction === 'downstream'
            ? link.from.type === node.type && link.from.id === node.id
            : link.to.type === node.type && link.to.id === node.id;
          if (!matches) continue;
          const target = direction === 'downstream' ? link.to : link.from;
          const key = `${target.type}:${target.id}`;
          if (!nodes.has(key)) {
            nodes.set(key, { ...target, depth: level });
            next.push(target);
          }
        }
      }
      frontier = next;
    }
    res.json({ root: start, direction, nodes: [...nodes.values()], links: links.filter((link) =>
      nodes.has(`${link.from.type}:${link.from.id}`) && nodes.has(`${link.to.type}:${link.to.id}`)) });
  }));

  // ---------------- reports ----------------
  app.post('/v1/capabilities/reports', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const kind = ['metric', 'trend', 'table', 'bar', 'line', 'map', 'status'].includes(String(b.kind)) ? String(b.kind) : 'table';
    if (b.datasetId) {
      const dataset = await loadDataset(client, String(b.datasetId));
      if (!dataset || (!isAdmin(principal) && dataset.data.tenant !== principal.tenantKey)) throw apiError(404, 'dataset_not_found', 'dataset not found');
    }
    const report = await createScoped(client, COLLECTIONS.reports, principal, {
      name: requiredString(b.name, 'name', 1, 200), description: optionalString(b.description, 'description', 1000),
      kind, datasetId: optionalString(b.datasetId, 'datasetId', 128), query: objectValue(b.query, 'query', 100_000),
      parameters: stringArray(b.parameters, 'parameters', 30),
    } as any) as unknown as ReportRecord;
    res.status(201).json({ report });
  }));

  app.get('/v1/capabilities/reports', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { items } = await listScoped<ReportRecord>(client, COLLECTIONS.reports, principal, { limit: 500 });
    res.json({ items, total: items.length });
  }));

  app.post('/v1/capabilities/reports/:id/run', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { record: report } = await getScoped<ReportRecord>(client, COLLECTIONS.reports, String(req.params.id), principal, 'report_not_found');
    let records: Array<Record<string, any>> = [];
    if (report.datasetId) {
      const dataset = await loadDataset(client, report.datasetId);
      if (!dataset) throw apiError(404, 'dataset_not_found', 'dataset not found');
      const caller = { authenticated: true, principal } as any;
      if (!canAccessDataset(dataset.data, caller)) throw apiError(404, 'dataset_not_found', 'dataset not found');
      const result = await queryDocuments<{ data: Record<string, any> }>(client, COLLECTIONS.records, {
        where: { datasetId: report.datasetId }, limit: 5000,
      });
      records = result.items.map((item) => item.data?.data || {});
    }
    const params = objectValue((req.body || {}).params, 'params', 20_000);
    const { rows, total } = reportRows(report, records, params);
    res.json({ report: { id: report.id, name: report.name, kind: report.kind }, rows, total, generatedAt: nowIso() });
  }));

  app.post('/v1/capabilities/reports/:id/export', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: report } = await getScoped<ReportRecord>(client, COLLECTIONS.reports, String(req.params.id), principal, 'report_not_found');
    const b = (req.body || {}) as Record<string, unknown>;
    const format = ['csv', 'json', 'ndjson'].includes(String(b.format)) ? String(b.format) as 'csv' | 'json' | 'ndjson' : 'json';
    const idempotencyKey = optionalString(b.idempotencyKey, 'idempotencyKey', 200) || req.header('idempotency-key') || undefined;
    if (idempotencyKey) {
      const existing = await queryDocuments<ReportRunRecord>(client, COLLECTIONS.reportRuns, {
        where: { tenant: principal.tenantKey, reportId: report.id, idempotencyKey }, limit: 1,
      });
      if (existing.items[0]) return res.json({ run: existing.items[0].data, duplicate: true });
    }
    let records: Array<Record<string, any>> = [];
    if (report.datasetId) {
      const dataset = await loadDataset(client, report.datasetId);
      if (!dataset || !canAccessDataset(dataset.data, { authenticated: true, principal } as any)) throw apiError(404, 'dataset_not_found', 'dataset not found');
      const result = await queryDocuments<{ data: Record<string, any> }>(client, COLLECTIONS.records, { where: { datasetId: report.datasetId }, limit: 5000 });
      records = result.items.map((item) => item.data?.data || {});
    }
    const { rows, total } = reportRows(report, records, objectValue(b.params, 'params', 20_000));
    const content = format === 'csv' ? toCsv(rows) : format === 'ndjson' ? rows.map((row) => JSON.stringify(row)).join('\n') : JSON.stringify(rows);
    const run = await createScoped(client, COLLECTIONS.reportRuns, principal, {
      reportId: report.id, format, rowCount: total, content: content.slice(0, 2_000_000),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    } as any) as unknown as ReportRunRecord;
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'data.report.export',
      correlationId: correlationIdOf(req), details: { reportId: report.id, format, rowCount: total },
    });
    res.status(201).json({ run, content, format });
  }));

  app.post('/v1/capabilities/reports/:id/schedule', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: report } = await getScoped<ReportRecord>(client, COLLECTIONS.reports, String(req.params.id), principal, 'report_not_found');
    const b = (req.body || {}) as Record<string, unknown>;
    const cron = requiredString(b.cron, 'cron', 5, 100);
    if (!/^(\*|[\d*/,\- ]+)$/.test(cron)) throw apiError(400, 'invalid_request', 'cron must be a valid schedule expression');
    const format = ['csv', 'json', 'ndjson'].includes(String(b.format)) ? String(b.format) as 'csv' | 'json' | 'ndjson' : 'csv';
    const schedule = { cron, format, recipient: optionalString(b.recipient, 'recipient', 320), enabled: b.enabled !== false };
    const updated = await updateScoped(client, COLLECTIONS.reports, report.id, principal, { schedule } as any);
    res.json({ report: updated });
  }));

  app.post('/v1/capabilities/report-schedules/run-due', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const reports = await queryDocuments<ReportRecord>(client, COLLECTIONS.reports, {
      where: isAdmin(principal) ? {} : { tenant: principal.tenantKey }, limit: 1000,
    });
    const due = reports.items.map((item) => item.data).filter((report) => report.schedule?.enabled);
    const deliveries = [];
    for (const report of due) {
      const bucket = new Date().toISOString().slice(0, 13); // hourly idempotency window
      const key = `schedule:${report.id}:${bucket}`;
      const existing = await queryDocuments<ReportRunRecord>(client, COLLECTIONS.reportRuns, { where: { reportId: report.id, idempotencyKey: key }, limit: 1 });
      if (existing.items[0]) { deliveries.push({ reportId: report.id, duplicate: true, runId: existing.items[0].id }); continue; }
      const records = report.datasetId
        ? (await queryDocuments<{ data: Record<string, any> }>(client, COLLECTIONS.records, { where: { datasetId: report.datasetId }, limit: 5000 })).items.map((item) => item.data?.data || {})
        : [];
      const { rows, total } = reportRows(report, records, {});
      const format = report.schedule!.format;
      const content = format === 'csv' ? toCsv(rows) : format === 'ndjson' ? rows.map((row) => JSON.stringify(row)).join('\n') : JSON.stringify(rows);
      const run = await createScoped(client, COLLECTIONS.reportRuns, principal, {
        reportId: report.id, format, rowCount: total, content: content.slice(0, 2_000_000), idempotencyKey: key,
      } as any) as unknown as ReportRunRecord;
      deliveries.push({ reportId: report.id, runId: run.id, recipient: report.schedule?.recipient, duplicate: false });
    }
    res.json({ deliveries, count: deliveries.length });
  }));

  // ---------------- dashboards ----------------
  app.post('/v1/capabilities/dashboards', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const widgets = Array.isArray(b.widgets) ? b.widgets.slice(0, 50).map((widget: any) => ({
      id: String(widget?.id || newId()), reportId: requiredString(widget?.reportId, 'widget.reportId', 1, 128),
      title: optionalString(widget?.title, 'widget.title', 200),
      x: Number(widget?.x) || 0, y: Number(widget?.y) || 0, w: Number(widget?.w) || 4, h: Number(widget?.h) || 2,
    })) : [];
    const dashboard = await createScoped(client, COLLECTIONS.dashboards, principal, {
      name: requiredString(b.name, 'name', 1, 200), widgets, filters: objectValue(b.filters, 'filters', 20_000),
    } as any) as unknown as DashboardRecord;
    res.status(201).json({ dashboard });
  }));

  app.get('/v1/capabilities/dashboards', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { items } = await listScoped<DashboardRecord>(client, COLLECTIONS.dashboards, principal, { limit: 200 });
    res.json({ items, total: items.length });
  }));

  app.post('/v1/capabilities/dashboards/:id/share', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: dashboard } = await getScoped<DashboardRecord>(client, COLLECTIONS.dashboards, String(req.params.id), principal, 'dashboard_not_found');
    const shareId = createHash('sha256').update(`${dashboard.id}:${dashboard.tenant}:${config.serviceToken || 'local'}`).digest('hex').slice(0, 32);
    const updated = await updateScoped(client, COLLECTIONS.dashboards, dashboard.id, principal, { shareId } as any);
    res.json({ dashboard: updated, shareUrl: `/dashboards/shared/${shareId}` });
  }));

  app.get('/v1/capabilities/dashboards/:id/data', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { record: dashboard } = await getScoped<DashboardRecord>(client, COLLECTIONS.dashboards, String(req.params.id), principal, 'dashboard_not_found');
    let queryFilters: Record<string, any> = {};
    if (typeof req.query.filters === 'string' && req.query.filters) {
      try { queryFilters = JSON.parse(req.query.filters); } catch { throw apiError(400, 'invalid_request', 'filters must be JSON'); }
    }
    const filters = { ...(dashboard.filters || {}), ...queryFilters };
    const widgets = [];
    for (const widget of dashboard.widgets) {
      const reportDoc = await getDocumentOrNull<ReportRecord>(client, COLLECTIONS.reports, widget.reportId);
      if (!reportDoc) { widgets.push({ ...widget, error: 'report_not_found' }); continue; }
      if (reportDoc.data.tenant !== principal.tenantKey && !isAdmin(principal)) { widgets.push({ ...widget, error: 'report_not_found' }); continue; }
      let records: Array<Record<string, any>> = [];
      if (reportDoc.data.datasetId) {
        const dataset = await loadDataset(client, reportDoc.data.datasetId);
        if (!dataset || !canAccessDataset(dataset.data, { authenticated: true, principal } as any)) { widgets.push({ ...widget, error: 'dataset_not_found' }); continue; }
        const result = await queryDocuments<{ data: Record<string, any> }>(client, COLLECTIONS.records, { where: { datasetId: reportDoc.data.datasetId }, limit: 5000 });
        records = result.items.map((item) => item.data?.data || {});
      }
      const data = reportRows(reportDoc.data, records, filters);
      widgets.push({ ...widget, report: { id: reportDoc.data.id, name: reportDoc.data.name, kind: reportDoc.data.kind }, ...data });
    }
    res.json({ dashboard: { id: dashboard.id, name: dashboard.name, filters }, widgets });
  }));
}
