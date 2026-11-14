// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Tier-2 warehouse capability: manager-facing OLAP datasets, saved queries,
 * dashboards and ETL recipes over the Tier-1 Synapse Warehouse.
 *
 * Tier-1 owns DuckDB, SQL execution, batch/stream ETL and SynapseStream
 * consumption. Tier-2 only validates intent, scopes reports/dashboards to the
 * caller tenant (Base) and forwards data operations with the caller's
 * credential through @synapseone/sdk.
 */
import { randomUUID } from 'crypto';
import { Express } from 'express';
import { SynapseOneError, SynapseOneClient } from '@synapseone/sdk';
import { Caller, credentialClient } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { COLLECTIONS, queryDocuments, serviceClient } from '../platform';
import { readContext, writeContext } from './shared';
import {
  createScoped, deleteScoped, getScoped, listScoped, newId, nowIso, optionalString, requiredString,
  updateScoped,
} from './module-helpers';

interface WarehouseReport {
  id: string;
  tenant: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  description?: string;
  sql: string;
  limit: number;
  datasetId?: string;
  visibility: 'private' | 'published';
  shareId?: string;
  publishedAt?: string;
  snapshot?: WarehouseSnapshot;
}

interface WarehouseSnapshot {
  columns: string[];
  types?: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  generatedAt: string;
}

interface DashboardWidget {
  id: string;
  reportId: string;
  title?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

interface WarehouseDashboard {
  id: string;
  tenant: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  description?: string;
  widgets: DashboardWidget[];
  visibility: 'private' | 'published';
  shareId?: string;
  publishedAt?: string;
  snapshots?: Record<string, WarehouseSnapshot>;
}

const DATASET_ID_RE = /^[a-z][a-z0-9_]{1,40}$/;
const MAX_SQL = 100_000;
const MAX_SNAPSHOT_BYTES = 220_000;

function assertSnapshotFits(rows: unknown, label: string): void {
  if (Buffer.byteLength(JSON.stringify(rows ?? null)) > MAX_SNAPSHOT_BYTES) {
    throw apiError(
      413,
      'payload_too_large',
      `${label} exceeds ${MAX_SNAPSHOT_BYTES} bytes; lower the report limit before publishing`,
    );
  }
}

function warehouseClient(config: ServiceConfig, caller: Caller): SynapseOneClient {
  if (!caller.authenticated || !caller.credential) {
    throw apiError(401, 'unauthorized', 'a verified Tier-1 credential is required for warehouse operations');
  }
  return credentialClient(config, caller.credential);
}

function upstream(error: unknown): never {
  if (error instanceof SynapseOneError) {
    const body = error.body as Record<string, any> | undefined;
    const code = String(body?.error || 'warehouse_upstream_error').slice(0, 80) as any;
    throw apiError(
      error.status || 502,
      code,
      String(body?.message || error.message || 'the warehouse rejected the request').slice(0, 500),
      body?.details,
    );
  }
  throw error;
}

async function callWarehouse(
  config: ServiceConfig,
  caller: Caller,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<any> {
  try {
    return await warehouseClient(config, caller).call(method, path, body);
  } catch (error) {
    upstream(error);
  }
}

function sqlText(value: unknown): string {
  const sql = String(value ?? '').trim();
  if (!sql || sql.length > MAX_SQL) {
    throw apiError(400, 'invalid_sql', `sql is required and must be ≤${MAX_SQL} characters`);
  }
  if (!/^(select|with)\b/i.test(sql)) {
    throw apiError(400, 'invalid_sql', 'only read-only SELECT/WITH queries are allowed');
  }
  return sql;
}

function limitValue(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 200;
  return Math.min(Math.max(Math.floor(parsed), 1), 5000);
}

function datasetId(value: unknown): string {
  const id = String(value ?? '').trim();
  if (!DATASET_ID_RE.test(id)) throw apiError(400, 'invalid_dataset_id', 'datasetId is invalid');
  return id;
}

function reportBody(body: Record<string, unknown>) {
  return {
    name: requiredString(body.name, 'name', 1, 160),
    description: optionalString(body.description, 'description', 500),
    sql: sqlText(body.sql),
    limit: limitValue(body.limit),
    ...(body.datasetId !== undefined ? { datasetId: datasetId(body.datasetId) } : {}),
  };
}

function reportPatch(body: Record<string, unknown>): Partial<WarehouseReport> {
  const patch: Partial<WarehouseReport> = {};
  if (body.name !== undefined) patch.name = requiredString(body.name, 'name', 1, 160);
  if (body.description !== undefined) patch.description = optionalString(body.description, 'description', 500);
  if (body.sql !== undefined) patch.sql = sqlText(body.sql);
  if (body.limit !== undefined) patch.limit = limitValue(body.limit);
  if (body.datasetId !== undefined) patch.datasetId = datasetId(body.datasetId);
  if (!Object.keys(patch).length) {
    throw apiError(400, 'invalid_request', 'provide at least one of name, description, sql, limit or datasetId');
  }
  return patch;
}

function dashboardPatch(body: Record<string, unknown>): Partial<WarehouseDashboard> {
  const patch: Partial<WarehouseDashboard> = {};
  if (body.name !== undefined) patch.name = requiredString(body.name, 'name', 1, 160);
  if (body.description !== undefined) patch.description = optionalString(body.description, 'description', 500);
  if (body.widgets !== undefined) patch.widgets = widgetList(body.widgets);
  if (!Object.keys(patch).length) {
    throw apiError(400, 'invalid_request', 'provide at least one of name, description or widgets');
  }
  return patch;
}

function widgetList(value: unknown): DashboardWidget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    throw apiError(400, 'invalid_widgets', 'widgets must contain 1..12 report widgets');
  }
  return value.map((raw, index) => {
    const item = (raw || {}) as Record<string, unknown>;
    const reportId = String(item.reportId ?? '').trim();
    if (!reportId) throw apiError(400, 'invalid_widgets', `widgets[${index}].reportId is required`);
    return {
      id: String(item.id || newId()),
      reportId,
      ...(item.title ? { title: String(item.title).slice(0, 120) } : {}),
      x: Number.isFinite(Number(item.x)) ? Number(item.x) : 0,
      y: Number.isFinite(Number(item.y)) ? Number(item.y) : 0,
      w: Number.isFinite(Number(item.w)) ? Number(item.w) : 6,
      h: Number.isFinite(Number(item.h)) ? Number(item.h) : 4,
    };
  });
}

async function runSql(
  config: ServiceConfig,
  caller: Caller,
  sql: string,
  limit: number,
): Promise<WarehouseSnapshot> {
  const result: any = await callWarehouse(config, caller, 'POST', '/v1/warehouse/query', { sql, limit });
  return {
    columns: Array.isArray(result?.columns) ? result.columns : [],
    types: Array.isArray(result?.types) ? result.types : [],
    rows: Array.isArray(result?.rows) ? result.rows : [],
    rowCount: Number(result?.rowCount ?? 0),
    generatedAt: nowIso(),
  };
}

function publicWhere(shareId: string): Record<string, unknown> {
  return { shareId, visibility: 'published' };
}

const SEED_DATASETS: Record<string, Record<string, unknown>> = {
  city_incidents: {
    name: 'City incidents',
    description: 'Raw incident feed used by the ETL and dashboard use cases.',
    columns: [
      { name: 'ts', type: 'timestamp' },
      { name: 'city', type: 'string' },
      { name: 'category', type: 'string' },
      { name: 'severity', type: 'number' },
    ],
  },
  city_daily: {
    name: 'City daily rollup',
    description: 'Batch output: incidents per day and category.',
    columns: [
      { name: 'day', type: 'timestamp' },
      { name: 'category', type: 'string' },
      { name: 'events', type: 'number' },
    ],
  },
  sensor_readings: {
    name: 'Sensor readings',
    description: 'Stream output from the iot-sensors SynapseStream topic.',
    mode: 'stream',
    streamTopic: 'iot-sensors',
    columns: [
      { name: 'ts', type: 'timestamp' },
      { name: 'device_id', type: 'string' },
      { name: 'value', type: 'number' },
    ],
  },
  air_quality: {
    name: 'Air quality',
    description: 'Curated open-data snapshot for public reports.',
    columns: [
      { name: 'ts', type: 'timestamp' },
      { name: 'station', type: 'string' },
      { name: 'pm25', type: 'number' },
    ],
  },
};

const SEED_ROWS: Record<string, Array<Record<string, unknown>>> = {
  city_incidents: [
    { ts: '2026-11-10T08:00:00Z', city: 'Hanoi', category: 'traffic', severity: 2 },
    { ts: '2026-11-10T09:00:00Z', city: 'Hanoi', category: 'flood', severity: 4 },
    { ts: '2026-11-10T10:00:00Z', city: 'Da Nang', category: 'flood', severity: 3 },
    { ts: '2026-11-11T08:30:00Z', city: 'Hanoi', category: 'traffic', severity: 2 },
    { ts: '2026-11-11T11:00:00Z', city: 'Ho Chi Minh City', category: 'air-quality', severity: 3 },
    { ts: '2026-11-11T12:00:00Z', city: 'Da Nang', category: 'traffic', severity: 1 },
  ],
  sensor_readings: [
    { ts: '2026-11-11T10:00:00Z', device_id: 'sensor-01', value: 24.5 },
    { ts: '2026-11-11T10:05:00Z', device_id: 'sensor-01', value: 24.9 },
    { ts: '2026-11-11T10:00:00Z', device_id: 'sensor-02', value: 31.2 },
    { ts: '2026-11-11T10:05:00Z', device_id: 'sensor-02', value: 31.8 },
  ],
  air_quality: [
    { ts: '2026-11-11T09:00:00Z', station: 'Hanoi-Westlake', pm25: 38.2 },
    { ts: '2026-11-11T09:00:00Z', station: 'DaNang-HanRiver', pm25: 21.4 },
    { ts: '2026-11-11T10:00:00Z', station: 'Hanoi-Westlake', pm25: 41.7 },
    { ts: '2026-11-11T10:00:00Z', station: 'DaNang-HanRiver', pm25: 19.8 },
  ],
};

const CITY_DAILY_SQL =
  "SELECT date_trunc('day', ts) AS day, category, count(*) AS events\n" +
  'FROM city_incidents GROUP BY 1, 2 ORDER BY 1 DESC';

async function ensureDataset(
  config: ServiceConfig,
  caller: Caller,
  id: string,
  existing: Set<string>,
): Promise<void> {
  if (existing.has(id)) return;
  const definition = SEED_DATASETS[id];
  if (!definition) throw apiError(500, 'internal_error', `seed definition missing for ${id}`);
  await callWarehouse(config, caller, 'POST', '/v1/warehouse/datasets', { id, ...definition });
  const rows = SEED_ROWS[id];
  if (rows?.length) {
    await callWarehouse(config, caller, 'POST', `/v1/warehouse/datasets/${encodeURIComponent(id)}/rows`, { rows });
  }
  existing.add(id);
}

async function ensureReport(
  client: SynapseOneClient,
  principal: import('../auth').CallerPrincipal,
  name: string,
  description: string,
  sql: string,
): Promise<WarehouseReport> {
  const existing = await listScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, principal, { limit: 500 });
  const found = existing.items.find((report) => report.name === name);
  if (found) return found;
  return createScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, principal, {
    name,
    description,
    sql,
    limit: 200,
    visibility: 'private',
  } as any);
}

export function registerWarehouseRoutes(app: Express, config: ServiceConfig): void {
  // ---- status, datasets, query, templates ----
  app.get('/v1/capabilities/warehouse/status', handler(async (req, res) => {
    const { caller } = await readContext(req, config);
    try {
      const datasets: any = await warehouseClient(config, caller).call('GET', '/v1/warehouse/datasets');
      res.setHeader('cache-control', 'no-store');
      res.json({
        capability: 'warehouse',
        status: 'ok',
        dependency: 'synapseone-warehouse',
        datasetCount: Array.isArray(datasets?.items) ? datasets.items.length : 0,
      });
    } catch {
      res.setHeader('cache-control', 'no-store');
      res.json({ capability: 'warehouse', status: 'degraded', dependency: 'synapseone-warehouse' });
    }
  }));

  app.get('/v1/capabilities/warehouse/datasets', handler(async (req, res) => {
    const { caller } = await readContext(req, config);
    const result = await callWarehouse(config, caller, 'GET', '/v1/warehouse/datasets');
    res.setHeader('cache-control', 'no-store');
    res.json(result);
  }));

  app.post('/v1/capabilities/warehouse/datasets', handler(async (req, res) => {
    const { caller } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    if (!Array.isArray(body.columns) || !body.columns.length) {
      throw apiError(400, 'invalid_columns', 'columns must be a non-empty array');
    }
    const id = body.id !== undefined ? datasetId(body.id) : undefined;
    const payload = {
      ...(id ? { id } : {}),
      name: requiredString(body.name, 'name', 1, 120),
      columns: body.columns,
      ...(body.description !== undefined ? { description: String(body.description).slice(0, 500) } : {}),
      ...(body.mode !== undefined ? { mode: String(body.mode) } : {}),
      ...(body.streamTopic !== undefined ? { streamTopic: String(body.streamTopic) } : {}),
    };
    const created = await callWarehouse(config, caller, 'POST', '/v1/warehouse/datasets', payload);
    res.status(201).json(created);
  }));

  app.get('/v1/capabilities/warehouse/datasets/:id', handler(async (req, res) => {
    const { caller } = await readContext(req, config);
    const id = datasetId(String(req.params.id));
    res.setHeader('cache-control', 'no-store');
    res.json(await callWarehouse(config, caller, 'GET', `/v1/warehouse/datasets/${encodeURIComponent(id)}`));
  }));

  app.delete('/v1/capabilities/warehouse/datasets/:id', handler(async (req, res) => {
    const { caller } = await writeContext(req, config);
    const id = datasetId(String(req.params.id));
    res.json(await callWarehouse(config, caller, 'DELETE', `/v1/warehouse/datasets/${encodeURIComponent(id)}`));
  }));

  app.post('/v1/capabilities/warehouse/datasets/:id/rows', handler(async (req, res) => {
    const { caller } = await writeContext(req, config);
    const id = datasetId(String(req.params.id));
    const body = (req.body || {}) as Record<string, unknown>;
    if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 5000) {
      throw apiError(400, 'invalid_rows', 'rows must contain 1..5000 objects');
    }
    const result = await callWarehouse(config, caller, 'POST', `/v1/warehouse/datasets/${encodeURIComponent(id)}/rows`, { rows: body.rows });
    res.status(201).json(result);
  }));

  app.post('/v1/capabilities/warehouse/query', handler(async (req, res) => {
    const { caller } = await readContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const result = await callWarehouse(config, caller, 'POST', '/v1/warehouse/query', {
      sql: sqlText(body.sql),
      limit: limitValue(body.limit),
    });
    res.setHeader('cache-control', 'no-store');
    res.json(result);
  }));

  app.get('/v1/capabilities/warehouse/templates', handler(async (req, res) => {
    const { caller } = await readContext(req, config);
    res.setHeader('cache-control', 'no-store');
    res.json(await callWarehouse(config, caller, 'GET', '/v1/warehouse/templates'));
  }));

  // SynapseFlow ETL templates (the drag/drop half of the Tier-2 story).
  app.get('/v1/capabilities/warehouse/workflow-templates', handler(async (req, res) => {
    const { caller } = await readContext(req, config);
    const templates: any = await warehouseClient(config, caller).workflow.listTemplates();
    const items = (Array.isArray(templates) ? templates : [])
      .filter((item: any) => String(item?.name || '').startsWith('etl-'))
      .map((item: any) => ({ name: String(item.name), description: String(item.description || '') }));
    res.setHeader('cache-control', 'no-store');
    res.json({ items });
  }));

  app.post('/v1/capabilities/warehouse/workflow-templates/:name/instantiate', handler(async (req, res) => {
    const { caller } = await writeContext(req, config);
    const name = String(req.params.name || '');
    if (!/^etl-[a-z0-9-]{1,64}$/.test(name)) {
      throw apiError(400, 'invalid_request', 'unknown SynapseFlow ETL template');
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const created = await warehouseClient(config, caller).workflow.createWorkflowFromTemplate(
      name,
      body.name !== undefined ? String(body.name).slice(0, 160) : undefined,
    );
    res.status(201).json(created);
  }));

  // ---- ETL jobs ----
  app.get('/v1/capabilities/warehouse/jobs', handler(async (req, res) => {
    const { caller } = await readContext(req, config);
    res.setHeader('cache-control', 'no-store');
    res.json(await callWarehouse(config, caller, 'GET', '/v1/warehouse/jobs'));
  }));

  app.post('/v1/capabilities/warehouse/etl/batch', handler(async (req, res) => {
    const { caller } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const result = await callWarehouse(config, caller, 'POST', '/v1/warehouse/etl/batch', {
      name: optionalString(body.name, 'name', 120),
      targetDatasetId: datasetId(body.targetDatasetId),
      sql: sqlText(body.sql),
      writeMode: body.writeMode === 'replace' ? 'replace' : 'append',
    });
    res.status(201).json(result);
  }));

  app.post('/v1/capabilities/warehouse/etl/stream', handler(async (req, res) => {
    const { caller } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const result = await callWarehouse(config, caller, 'POST', '/v1/warehouse/etl/stream', {
      name: optionalString(body.name, 'name', 120),
      targetDatasetId: datasetId(body.targetDatasetId),
      streamTopic: requiredString(body.streamTopic, 'streamTopic', 1, 64),
      ...(body.batchSize !== undefined ? { batchSize: Number(body.batchSize) } : {}),
      ...(body.intervalMs !== undefined ? { intervalMs: Number(body.intervalMs) } : {}),
    });
    res.status(result?.created === false ? 200 : 201).json(result);
  }));

  app.post('/v1/capabilities/warehouse/jobs/:id/run', handler(async (req, res) => {
    const { caller } = await writeContext(req, config);
    const result = await callWarehouse(config, caller, 'POST', `/v1/warehouse/jobs/${encodeURIComponent(String(req.params.id))}/run`, {});
    res.json(result);
  }));

  app.post('/v1/capabilities/warehouse/jobs/:id/pause', handler(async (req, res) => {
    const { caller } = await writeContext(req, config);
    res.json(await callWarehouse(config, caller, 'POST', `/v1/warehouse/jobs/${encodeURIComponent(String(req.params.id))}/pause`, {}));
  }));

  app.get('/v1/capabilities/warehouse/jobs/:id', handler(async (req, res) => {
    const { caller } = await readContext(req, config);
    res.setHeader('cache-control', 'no-store');
    res.json(await callWarehouse(config, caller, 'GET', `/v1/warehouse/jobs/${encodeURIComponent(String(req.params.id))}`));
  }));

  app.post('/v1/capabilities/warehouse/jobs/:id/resume', handler(async (req, res) => {
    const { caller } = await writeContext(req, config);
    res.json(await callWarehouse(config, caller, 'POST', `/v1/warehouse/jobs/${encodeURIComponent(String(req.params.id))}/resume`, {}));
  }));

  app.delete('/v1/capabilities/warehouse/jobs/:id', handler(async (req, res) => {
    const { caller } = await writeContext(req, config);
    res.json(await callWarehouse(config, caller, 'DELETE', `/v1/warehouse/jobs/${encodeURIComponent(String(req.params.id))}`));
  }));

  // ---- saved reports ----
  app.get('/v1/capabilities/warehouse/reports', handler(async (req, res) => {
    const { caller, principal, client } = await readContext(req, config);
    if (!principal) throw apiError(401, 'unauthorized', 'a verified credential is required');
    const listed = await listScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, principal, { limit: 200 });
    res.setHeader('cache-control', 'no-store');
    res.json(listed);
  }));

  app.post('/v1/capabilities/warehouse/reports', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const report = await createScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, principal, {
      ...reportBody(body),
      visibility: 'private',
    } as any);
    res.status(201).json(report);
  }));

  app.get('/v1/capabilities/warehouse/reports/:id', handler(async (req, res) => {
    const { principal, client } = await readContext(req, config);
    if (!principal) throw apiError(401, 'unauthorized', 'a verified credential is required');
    const found = await getScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, String(req.params.id), principal, 'report_not_found');
    res.json(found.record);
  }));

  app.patch('/v1/capabilities/warehouse/reports/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const found = await getScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, String(req.params.id), principal, 'report_not_found');
    // Editing a query invalidates its published snapshot until it is published again.
    const updated = await updateScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, found.record.id, principal, {
      ...reportPatch(body),
      visibility: 'private',
      shareId: undefined,
      publishedAt: undefined,
      snapshot: undefined,
    } as Partial<WarehouseReport>);
    res.json(updated);
  }));

  app.delete('/v1/capabilities/warehouse/reports/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const id = String(req.params.id);
    const found = await getScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, id, principal, 'report_not_found');
    const dashboards = await listScoped<WarehouseDashboard>(client, COLLECTIONS.warehouseDashboards, principal, { limit: 1000 });
    if (dashboards.items.some((dashboard) => dashboard.widgets.some((widget) => widget.reportId === id))) {
      throw apiError(409, 'report_in_use', 'remove the report from its dashboards before deleting it');
    }
    await deleteScoped(client, COLLECTIONS.warehouseReports, found.record.id, principal);
    res.json({ ok: true, id });
  }));

  app.post('/v1/capabilities/warehouse/reports/:id/run', handler(async (req, res) => {
    const { caller, principal, client } = await writeContext(req, config);
    const found = await getScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, String(req.params.id), principal, 'report_not_found');
    const snapshot = await runSql(config, caller, found.record.sql, found.record.limit);
    res.setHeader('cache-control', 'no-store');
    res.json({ reportId: found.record.id, name: found.record.name, result: snapshot });
  }));

  app.post('/v1/capabilities/warehouse/reports/:id/publish', handler(async (req, res) => {
    const { caller, principal, client } = await writeContext(req, config);
    const found = await getScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, String(req.params.id), principal, 'report_not_found');
    const snapshot = await runSql(config, caller, found.record.sql, found.record.limit);
    assertSnapshotFits(snapshot, 'report snapshot');
    const published = await updateScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, found.record.id, principal, {
      visibility: 'published',
      shareId: found.record.shareId || randomUUID(),
      publishedAt: nowIso(),
      snapshot,
    });
    res.json(published);
  }));

  // ---- dashboards ----
  app.get('/v1/capabilities/warehouse/dashboards', handler(async (req, res) => {
    const { principal, client } = await readContext(req, config);
    if (!principal) throw apiError(401, 'unauthorized', 'a verified credential is required');
    res.json(await listScoped<WarehouseDashboard>(client, COLLECTIONS.warehouseDashboards, principal, { limit: 100 }));
  }));

  app.post('/v1/capabilities/warehouse/dashboards', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const dashboard = await createScoped<WarehouseDashboard>(client, COLLECTIONS.warehouseDashboards, principal, {
      name: requiredString(body.name, 'name', 1, 160),
      description: optionalString(body.description, 'description', 500),
      widgets: widgetList(body.widgets),
      visibility: 'private',
    } as any);
    res.status(201).json(dashboard);
  }));

  app.get('/v1/capabilities/warehouse/dashboards/:id', handler(async (req, res) => {
    const { principal, client } = await readContext(req, config);
    if (!principal) throw apiError(401, 'unauthorized', 'a verified credential is required');
    const found = await getScoped<WarehouseDashboard>(client, COLLECTIONS.warehouseDashboards, String(req.params.id), principal, 'dashboard_not_found');
    res.setHeader('cache-control', 'no-store');
    res.json(found.record);
  }));

  app.patch('/v1/capabilities/warehouse/dashboards/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const found = await getScoped<WarehouseDashboard>(client, COLLECTIONS.warehouseDashboards, String(req.params.id), principal, 'dashboard_not_found');
    const updated = await updateScoped<WarehouseDashboard>(client, COLLECTIONS.warehouseDashboards, found.record.id, principal, {
      ...dashboardPatch(body),
      visibility: 'private',
      shareId: undefined,
      publishedAt: undefined,
      snapshots: undefined,
    } as Partial<WarehouseDashboard>);
    res.json(updated);
  }));

  app.delete('/v1/capabilities/warehouse/dashboards/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const id = String(req.params.id);
    const found = await getScoped<WarehouseDashboard>(client, COLLECTIONS.warehouseDashboards, id, principal, 'dashboard_not_found');
    await deleteScoped(client, COLLECTIONS.warehouseDashboards, found.record.id, principal);
    res.json({ ok: true, id });
  }));

  app.post('/v1/capabilities/warehouse/dashboards/:id/run', handler(async (req, res) => {
    const { caller, principal, client } = await writeContext(req, config);
    const found = await getScoped<WarehouseDashboard>(client, COLLECTIONS.warehouseDashboards, String(req.params.id), principal, 'dashboard_not_found');
    const widgets = [];
    for (const widget of found.record.widgets) {
      const report = await getScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, widget.reportId, principal, 'report_not_found');
      const snapshot = await runSql(config, caller, report.record.sql, report.record.limit);
      widgets.push({ widget, report: { id: report.record.id, name: report.record.name }, result: snapshot });
    }
    res.setHeader('cache-control', 'no-store');
    res.json({ dashboard: found.record, widgets });
  }));

  app.post('/v1/capabilities/warehouse/dashboards/:id/publish', handler(async (req, res) => {
    const { caller, principal, client } = await writeContext(req, config);
    const found = await getScoped<WarehouseDashboard>(client, COLLECTIONS.warehouseDashboards, String(req.params.id), principal, 'dashboard_not_found');
    const snapshots: Record<string, WarehouseSnapshot> = {};
    for (const widget of found.record.widgets) {
      const report = await getScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, widget.reportId, principal, 'report_not_found');
      snapshots[widget.reportId] = await runSql(config, caller, report.record.sql, report.record.limit);
    }
    assertSnapshotFits(snapshots, 'dashboard snapshots');
    res.json(await updateScoped<WarehouseDashboard>(client, COLLECTIONS.warehouseDashboards, found.record.id, principal, {
      visibility: 'published',
      shareId: found.record.shareId || randomUUID(),
      publishedAt: nowIso(),
      snapshots,
    }));
  }));

  // ---- public snapshots for Tier 3 ----
  app.get('/v1/capabilities/warehouse/public/reports/:shareId', handler(async (req, res) => {
    const found = await queryDocuments<WarehouseReport>(serviceClient(config), COLLECTIONS.warehouseReports, {
      where: publicWhere(String(req.params.shareId)), limit: 1,
    });
    const report = found.items[0]?.data;
    if (!report?.snapshot) throw apiError(404, 'report_not_found', 'published report not found');
    res.setHeader('cache-control', 'public, max-age=60');
    res.json({
      id: report.id,
      name: report.name,
      description: report.description,
      publishedAt: report.publishedAt,
      result: report.snapshot,
    });
  }));

  app.get('/v1/capabilities/warehouse/public/dashboards/:shareId', handler(async (req, res) => {
    const found = await queryDocuments<WarehouseDashboard>(serviceClient(config), COLLECTIONS.warehouseDashboards, {
      where: publicWhere(String(req.params.shareId)), limit: 1,
    });
    const dashboard = found.items[0]?.data;
    if (!dashboard?.snapshots) throw apiError(404, 'dashboard_not_found', 'published dashboard not found');
    res.setHeader('cache-control', 'public, max-age=60');
    res.json({
      id: dashboard.id,
      name: dashboard.name,
      description: dashboard.description,
      publishedAt: dashboard.publishedAt,
      widgets: dashboard.widgets.map((widget) => ({
        ...widget,
        result: dashboard.snapshots?.[widget.reportId] || null,
      })),
    });
  }));

  // ---- manager use cases (seedable demos) ----
  app.get('/v1/capabilities/warehouse/use-cases', handler(async (_req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.json({ items: WAREHOUSE_USE_CASES });
  }));

  app.post('/v1/capabilities/warehouse/use-cases/:id/seed', handler(async (req, res) => {
    const useCase = WAREHOUSE_USE_CASES.find((item) => item.id === String(req.params.id));
    if (!useCase) throw apiError(404, 'not_found', `unknown use case '${String(req.params.id)}'`);
    const { caller, principal, client } = await writeContext(req, config);

    const listed: any = await callWarehouse(config, caller, 'GET', '/v1/warehouse/datasets');
    const existing = new Set<string>(
      Array.isArray(listed?.items) ? listed.items.map((item: any) => String(item.id)) : [],
    );
    for (const id of useCase.datasets) await ensureDataset(config, caller, id, existing);

    if (useCase.id === 'city-operations') {
      await callWarehouse(config, caller, 'POST', '/v1/warehouse/etl/batch', {
        name: 'City daily rollup',
        targetDatasetId: 'city_daily',
        writeMode: 'replace',
        sql: CITY_DAILY_SQL,
      });
    }
    if (useCase.id === 'iot-sensors') {
      await callWarehouse(config, caller, 'POST', '/v1/warehouse/etl/stream', {
        name: 'sensor-stream-ingest',
        targetDatasetId: 'sensor_readings',
        streamTopic: 'iot-sensors',
        batchSize: 100,
        intervalMs: 1000,
      });
    }

    const reports: WarehouseReport[] = [];
    for (const query of useCase.queries) {
      reports.push(await ensureReport(client, principal, query.name, useCase.description, query.sql));
    }

    let dashboard: WarehouseDashboard | undefined;
    if (useCase.id === 'city-operations') {
      const dashboards = await listScoped<WarehouseDashboard>(client, COLLECTIONS.warehouseDashboards, principal, { limit: 100 });
      dashboard = dashboards.items.find((item) => item.name === 'City operations');
      if (!dashboard) {
        dashboard = await createScoped<WarehouseDashboard>(client, COLLECTIONS.warehouseDashboards, principal, {
          name: 'City operations',
          description: 'Incident volume, hotspots and daily ETL output for duty managers.',
          visibility: 'private',
          widgets: reports.map((report, index) => ({
            id: newId(),
            reportId: report.id,
            title: report.name,
            x: 0,
            y: index * 4,
            w: 12,
            h: 4,
          })),
        } as any);
      }
    }

    if (useCase.id === 'open-data-air-quality' && reports[0]) {
      const report = reports[0];
      const snapshot = await runSql(config, caller, report.sql, report.limit);
      await updateScoped<WarehouseReport>(client, COLLECTIONS.warehouseReports, report.id, principal, {
        visibility: 'published',
        shareId: report.shareId || randomUUID(),
        publishedAt: nowIso(),
        snapshot,
      });
    }

    res.status(201).json({
      ok: true,
      useCase: useCase.id,
      datasets: useCase.datasets,
      reports,
      ...(dashboard ? { dashboard } : {}),
    });
  }));
}

export const WAREHOUSE_USE_CASES = [
  {
    id: 'city-operations',
    name: 'City operations daily rollup',
    description: 'Incident ETL: raw incidents -> daily category rollup -> manager dashboard report.',
    datasets: ['city_incidents', 'city_daily'],
    queries: [
      {
        name: 'Incident hotspots',
        sql: 'SELECT city, count(*) AS incidents, avg(severity) AS avg_severity FROM city_incidents GROUP BY city ORDER BY incidents DESC',
      },
      {
        name: 'Daily rollup',
        sql: 'SELECT day, category, events FROM city_daily ORDER BY day DESC',
      },
    ],
  },
  {
    id: 'iot-sensors',
    name: 'IoT sensor stream',
    description: 'SynapseStream -> warehouse stream job -> per-device averages for a live dashboard.',
    datasets: ['sensor_readings'],
    queries: [
      {
        name: 'Sensor averages',
        sql: 'SELECT device_id, count(*) AS readings, avg(value) AS avg_value FROM sensor_readings GROUP BY device_id ORDER BY device_id',
      },
    ],
  },
  {
    id: 'open-data-air-quality',
    name: 'Open-data air quality',
    description: 'Curated air-quality snapshot published as a public Tier-2 report for Tier-3 sites.',
    datasets: ['air_quality'],
    queries: [
      {
        name: 'Latest air quality',
        sql: 'SELECT station, pm25, ts FROM air_quality ORDER BY ts DESC LIMIT 20',
      },
    ],
  },
];
