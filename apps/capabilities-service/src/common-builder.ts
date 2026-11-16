// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Fixed capability connectors for declarative pages. No client URL or service identity. */
import type { CallerCredential } from "./auth";
import type { ServiceConfig } from "./config";
import type { WorkspaceWidgetField } from "./workspace-plugins";
import { apiError } from "./errors";
import { geometryError } from "./geometry";

type Operation = {
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  json?: string[];
};
export interface CommonSource {
  key: string;
  path: string;
  itemKey?: string;
  detail?: string;
  operations: Partial<
    Record<"create" | "update" | "delete" | "execute", Operation>
  >;
}
const source = (
  key: string,
  path: string,
  itemKey: string,
  operations: CommonSource["operations"],
  detail?: string,
): CommonSource => ({
  key,
  path,
  itemKey,
  operations,
  ...(detail ? { detail } : {}),
});
export const COMMON_SOURCES: CommonSource[] = [
  source(
    "commonProjects",
    "projects",
    "project",
    {
      create: { method: "POST", path: "projects" },
      update: { method: "PATCH", path: "projects/{record_id}" },
    },
    "projects/{record_id}",
  ),
  source("commonTasks", "project-tasks", "task", {
    create: { method: "POST", path: "projects/{projectId}/tasks" },
    update: { method: "PATCH", path: "project-tasks/{record_id}" },
  }),
  source("commonWorkspaces", "workspaces", "workspace", {
    create: { method: "POST", path: "workspaces", json: ["members"] },
    update: {
      method: "PATCH",
      path: "workspaces/{record_id}",
      json: ["members"],
    },
    delete: { method: "DELETE", path: "workspaces/{record_id}" },
  }),
  source(
    "commonPages",
    "pages",
    "page",
    {
      create: {
        method: "POST",
        path: "workspaces/{workspaceId}/pages",
        json: ["tags"],
      },
      update: { method: "PUT", path: "pages/{record_id}", json: ["tags"] },
      delete: { method: "DELETE", path: "pages/{record_id}" },
    },
    "pages/{record_id}",
  ),
  source("commonInbox", "inbox", "item", {
    execute: { method: "POST", path: "inbox/{record_id}/read" },
    delete: { method: "POST", path: "inbox/{record_id}/archive" },
  }),
  source("commonComments", "comments", "comment", {
    create: { method: "POST", path: "comments", json: ["mentions"] },
  }),
  source(
    "commonForms",
    "forms",
    "form",
    {
      create: { method: "POST", path: "forms", json: ["schema", "uiSchema"] },
      update: {
        method: "POST",
        path: "forms/{record_id}/versions",
        json: ["schema", "uiSchema"],
      },
      execute: {
        method: "POST",
        path: "forms/{record_id}/validate",
        json: ["values"],
      },
    },
    "forms/{record_id}",
  ),
  source("commonProcesses", "processes", "process", {
    create: {
      method: "POST",
      path: "processes",
      json: ["nodes", "edges", "assignment"],
    },
    execute: {
      method: "POST",
      path: "processes/{record_id}/start",
      json: ["input"],
    },
  }),
  source("commonProcessInstances", "process-instances", "instance", {
    execute: {
      method: "POST",
      path: "process-instances/{record_id}/transition",
      json: ["input"],
    },
  }),
  source("commonReports", "reports", "report", {
    create: { method: "POST", path: "reports", json: ["query", "parameters"] },
    execute: {
      method: "POST",
      path: "reports/{record_id}/run",
      json: ["params"],
    },
  }),
  source("commonDashboards", "dashboards", "dashboard", {
    create: { method: "POST", path: "dashboards", json: ["widgets"] },
    execute: { method: "POST", path: "dashboards/{record_id}/share" },
  }),
  source(
    "commonFiles",
    "files",
    "file",
    {
      create: { method: "POST", path: "files" },
      execute: { method: "POST", path: "files/{file_id}/complete" },
      delete: { method: "DELETE", path: "files/{record_id}" },
    },
    "files/{record_id}",
  ),
  source(
    "commonOcr",
    "ocr/jobs",
    "job",
    {
      create: { method: "POST", path: "ocr/jobs", json: ["pages"] },
      execute: { method: "POST", path: "ocr/jobs/{record_id}/redact" },
    },
    "ocr/jobs/{record_id}",
  ),
  source("commonPeople", "people", "person", {
    create: { method: "POST", path: "people", json: ["skills"] },
  }),
  source("commonKpis", "kpis", "kpi", {
    create: { method: "POST", path: "kpis" },
    execute: { method: "POST", path: "kpis/{record_id}/checkins" },
  }),
  source("commonTimesheets", "timesheets", "timesheet", {
    create: { method: "POST", path: "timesheets", json: ["entries"] },
    execute: { method: "POST", path: "timesheets/{record_id}/submit" },
  }),
  source("commonAgents", "agents", "agent", {
    create: { method: "POST", path: "agents", json: ["tools"] },
    execute: {
      method: "POST",
      path: "agents/{record_id}/runs",
      json: ["input", "toolCalls"],
    },
  }),
  source("commonAgentRuns", "agent-runs", "run", {
    execute: { method: "POST", path: "agent-runs/{record_id}/resume" },
  }),
  source("commonKnowledge", "rag/documents", "document", {
    create: { method: "POST", path: "rag/documents", json: ["acl"] },
  }),
  source("commonAssistant", "rag/usage", "answer", {
    execute: { method: "POST", path: "rag/query" },
  }),
  source(
    "commonApprovals",
    "approvals",
    "approval",
    {
      create: {
        method: "POST",
        path: "approvals",
        json: ["payload", "approverRoles"],
      },
      execute: { method: "POST", path: "approvals/{record_id}/decide" },
      delete: { method: "POST", path: "approvals/{record_id}/cancel" },
    },
    "approvals/{record_id}",
  ),
];
export const commonSource = (key?: string) =>
  COMMON_SOURCES.find((source) => source.key === key);
function fillPath(template: string, values: Record<string, unknown>) {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    const value = String(values[key] ?? "");
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(value))
      throw apiError(
        400,
        "field_required",
        `${key} must be a valid record identifier`,
        { field: key },
      );
    return encodeURIComponent(value);
  });
}
export async function callCommon(
  config: ServiceConfig,
  credential: CallerCredential | undefined,
  product: string,
  path: string,
  method = "GET",
  body?: unknown,
  acceptedStatuses: number[] = [],
): Promise<any> {
  if (!credential || !["city", "sos"].includes(product))
    throw apiError(403, "forbidden", "a verified app session is required");
  const response = await fetch(
    `${config.publicUrl.replace(/\/$/, "")}/v1/capabilities/${path}`,
    {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(25000),
      headers: {
        [credential.kind === "bearer" ? "Authorization" : "X-API-Key"]:
          credential.kind === "bearer"
            ? `Bearer ${credential.value}`
            : credential.value,
        "X-Workspace-App": product,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  ).catch(() => {
    throw apiError(
      503,
      "capability_failed",
      "The capability is temporarily unavailable",
    );
  });
  const payload =
    response.status === 204
      ? { ok: true }
      : await response.json().catch(() => {
          throw apiError(
            502,
            "capability_failed",
            "The capability returned an invalid response",
          );
        });
  if (!response.ok && !acceptedStatuses.includes(response.status))
    throw apiError(
      response.status,
      (payload as any)?.error?.code || "capability_failed",
      (payload as any)?.error?.message ||
        "The capability refused this operation",
    );
  return payload;
}
export function validateCommonValues(
  fields: WorkspaceWidgetField[],
  input: unknown,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw apiError(400, "invalid_request", "expected declared values");
  const values = { ...input } as Record<string, unknown>;
  if (
    Object.keys(values).some(
      (key) => !fields.some((field) => field.name === key),
    )
  )
    throw apiError(400, "invalid_request", "undeclared form field");
  for (const field of fields) {
    let value = values[field.name];
    if (field.type === "json" && value !== null && typeof value === "object") {
      try { value = values[field.name] = JSON.stringify(value); }
      catch { throw apiError(400, "invalid_request", field.label + " must contain valid JSON"); }
    }
    if (value === undefined || value === null || value === "") {
      if (field.required)
        throw apiError(400, "field_required", field.label + " is required");
      continue;
    }
    if (
      !["string", "number", "boolean"].includes(typeof value) ||
      String(value).length > 50000
    )
      throw apiError(400, "invalid_request", "invalid field value");
    if (
      field.type === "number" &&
      (typeof value !== "number" || !Number.isFinite(value))
    )
      throw apiError(400, "invalid_request", field.label + " must be a number");
    if (field.type === "checkbox" && typeof value !== "boolean")
      throw apiError(
        400,
        "invalid_request",
        field.label + " must be a boolean",
      );
    if (
      !["number", "checkbox"].includes(field.type) &&
      typeof value !== "string"
    )
      throw apiError(400, "invalid_request", field.label + " must be text");
    if (field.options?.length && !field.options.includes(String(value)))
      throw apiError(400, "invalid_request", "invalid option");
    if (
      field.type === "email" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))
    )
      throw apiError(400, "invalid_request", "invalid email");
    if (
      ["date", "datetime-local"].includes(field.type) &&
      (!/^\d{4}-\d{2}-\d{2}/.test(String(value)) ||
        !Number.isFinite(Date.parse(String(value))))
    )
      throw apiError(400, "invalid_request", "invalid date");
    if (field.type === "json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(value));
      } catch {
        throw apiError(
          400,
          "invalid_request",
          field.label + " must contain valid JSON",
        );
      }
      if (field.editor === "geometry") {
        const error = geometryError(parsed);
        if (error) throw apiError(400, "invalid_request", field.label + ": " + error);
      }
      if (["schema", "query"].includes(field.editor || "") && (!parsed || typeof parsed !== "object" || Array.isArray(parsed)))
        throw apiError(400, "invalid_request", field.label + " must contain a JSON object");
    }
  }
  return { ...values };
}
export async function commonRows(
  config: ServiceConfig,
  credential: CallerCredential | undefined,
  product: string,
  key: string,
) {
  const spec = commonSource(key);
  if (!spec)
    throw apiError(400, "resource_not_allowed", "unknown common source");
  const rows: any[] = [];
  const paged = [
    "commonTasks",
    "commonProjects",
    "commonPages",
    "commonFiles",
  ].includes(key);
  for (let offset = 0; offset < 5000; offset += 100) {
    const result = await callCommon(
      config,
      credential,
      product,
      spec.path + (paged ? `?limit=100&offset=${offset}` : ""),
    );
    const items = Array.isArray(result) ? result : result.items || [result];
    rows.push(...items);
    if (
      !paged &&
      typeof result.total === "number" &&
      result.total > items.length
    )
      throw apiError(
        422,
        "capability_failed",
        "This capability collection exceeds its supported view size",
      );
    if (
      !paged ||
      items.length === 0 ||
      rows.length >= (result.total ?? items.length)
    )
      return rows;
  }
  throw apiError(
    422,
    "capability_failed",
    "Collection is too large for this widget; use a dedicated filtered view",
  );
}
export async function commonDetail(
  config: ServiceConfig,
  credential: CallerCredential | undefined,
  product: string,
  key: string,
  id: string,
) {
  const spec = commonSource(key);
  if (!spec) throw apiError(404, "not_found", "unknown common source");
  if (spec.detail) {
    const result = await callCommon(
      config,
      credential,
      product,
      fillPath(spec.detail, { record_id: id }),
    );
    return result[spec.itemKey || ""] || result;
  }
  const rows = await commonRows(config, credential, product, key);
  const row = rows.find((row: any) => row.id === id);
  if (!row) throw apiError(404, "not_found", "record not found");
  return row;
}
export async function commonAction(
  config: ServiceConfig,
  credential: CallerCredential | undefined,
  product: string,
  key: string,
  action: string,
  values: Record<string, unknown>,
) {
  const spec = commonSource(key),
    op = spec?.operations[action as keyof CommonSource["operations"]];
  if (!op)
    throw apiError(
      400,
      "mutation_not_supported",
      "this capability action is not supported",
    );
  const path = fillPath(op.path, values);
  const body = { ...values };
  for (const match of op.path.matchAll(/\{([^}]+)\}/g)) delete body[match[1]];
  for (const key of op.json || [])
    if (typeof body[key] === "string") {
      try {
        body[key] = JSON.parse(body[key] as string);
      } catch {
        throw apiError(
          400,
          "invalid_request",
          `${key} must contain valid JSON`,
        );
      }
    }
  return callCommon(
    config,
    credential,
    product,
    path,
    op.method,
    op.method === "DELETE" ? undefined : body,
  );
}

/** Binary transport stays inside the public Tier-2 files contract and caller's app. */
export async function callCommonBytes(
  config: ServiceConfig, credential: CallerCredential | undefined, product: string,
  path: string, method = "GET", bytes?: Buffer, contentType = "application/octet-stream",
): Promise<{ bytes: Buffer; contentType: string; disposition: string | null }> {
  if (!credential || !["city", "sos"].includes(product) || !/^files\/[A-Za-z0-9._-]+\/content$/.test(path))
    throw apiError(403, "forbidden", "a verified app file binding is required");
  const response = await fetch(`${config.publicUrl.replace(/\/$/, "")}/v1/capabilities/${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(25000),
    headers: {
      [credential.kind === "bearer" ? "Authorization" : "X-API-Key"]: credential.kind === "bearer" ? `Bearer ${credential.value}` : credential.value,
      "X-Workspace-App": product, "Content-Type": contentType,
    },
    ...(bytes ? { body: new Uint8Array(bytes) } : {}),
  }).catch(() => { throw apiError(503, "capability_failed", "File storage is temporarily unavailable"); });
  if (!response.ok) {
    const payload: any = await response.json().catch(() => ({}));
    throw apiError(response.status, payload.error?.code || "capability_failed", payload.error?.message || "File storage refused this operation");
  }
  return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") || contentType, disposition: response.headers.get("content-disposition") };
}

export function fileTypeAccepted(accept: string | undefined, contentType: string): boolean {
  return !accept || accept.split(",").some(type => {
    const mime = type.trim();
    return mime === contentType || (mime.endsWith("/*") && contentType.startsWith(mime.slice(0, -1)));
  });
}
