// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Same-origin HTTP binding for workspace plugins and workflow artifacts.
 * Every request uses the verified DX bearer session from `httpClient`; the
 * console never derives a product URL from a plugin schema.
 */
import { api } from "./api";
import { httpClient } from "./httpClient";
import {
  WORKFLOW_ARTIFACTS_API,
  WORKSPACE_API_BASE,
  installedWidgetDataPath,
  installedWidgetExecutePath,
  isWorkspaceProduct,
  parseInstalledList,
  parseMembers,
  parsePlugin,
  parsePluginList,
  parseTokens,
  parseWidgetData,
  parseWorkflowArtifacts,
  parseWorkflowReadiness,
  parseWorkspaceCatalog,
  type InstalledPlugin,
  type PluginBundle,
  type WidgetData,
  type WorkflowArtifactSummary,
  type WorkflowReadiness,
  type WorkspaceCatalog,
  type WorkspaceMember,
  type WorkspaceAccess,
  type WorkspacePlugin,
  type WorkspaceProduct,
  type WorkspaceTokenMetadata,
  type WorkspaceWidget,
} from "./workspaces";

export interface PluginWriteBody {
  product: WorkspaceProduct;
  name: string;
  slug: string;
  audience: "admin" | "member";
  roles: string[];
  widgets: WorkspaceWidget[];
  version?: number;
}

export async function fetchCatalog(): Promise<WorkspaceCatalog> {
  return parseWorkspaceCatalog(
    await api.get<unknown>(`${WORKSPACE_API_BASE}/catalog`),
  );
}

export async function fetchPlugins(
  product: WorkspaceProduct,
): Promise<WorkspacePlugin[]> {
  const payload = await api.get<unknown>(
    `${WORKSPACE_API_BASE}/plugins?product=${encodeURIComponent(product)}`,
  );
  return parsePluginList(payload);
}

export async function createPlugin(
  body: PluginWriteBody,
): Promise<WorkspacePlugin> {
  return parsePlugin(
    await api.post<unknown>(`${WORKSPACE_API_BASE}/plugins`, body),
  );
}

export async function updatePlugin(
  id: string,
  body: Omit<PluginWriteBody, "product">,
): Promise<WorkspacePlugin> {
  return parsePlugin(
    await api.put<unknown>(
      `${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}`,
      body,
    ),
  );
}

export async function publishPlugin(
  id: string,
  version?: number,
): Promise<WorkspacePlugin> {
  return parsePlugin(
    await api.post<unknown>(
      `${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}/publish`,
      version === undefined ? {} : { version },
    ),
  );
}

export async function unpublishPlugin(
  id: string,
  version?: number,
): Promise<WorkspacePlugin> {
  return parsePlugin(
    await api.post<unknown>(
      `${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}/unpublish`,
      version === undefined ? {} : { version },
    ),
  );
}

export async function exportPluginBundle(
  id: string,
  options: { draft?: boolean } = {},
): Promise<unknown> {
  const suffix = options.draft ? "?draft=1" : "";
  return api.get<unknown>(
    `${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}/export${suffix}`,
  );
}

/**
 * Build the immutable, repository-tracked artifact for the plugin's Tier-3
 * product. The server refuses drafts and returns the exact bundle the Tier-3
 * sync CLI validates.
 */
export async function buildPluginBundle(id: string): Promise<unknown> {
  return api.get<unknown>(
    `${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}/build`,
  );
}

export async function importPluginBundle(
  bundle: PluginBundle,
): Promise<WorkspacePlugin> {
  return parsePlugin(
    await api.post<unknown>(`${WORKSPACE_API_BASE}/import`, bundle),
  );
}

/**
 * Member runtime list. This endpoint is role-filtered by the server; it is
 * never used to infer organization installation state in the admin console.
 */
export async function fetchInstalled(): Promise<InstalledPlugin[]> {
  return parseInstalledList(
    await api.get<unknown>(`${WORKSPACE_API_BASE}/installed`),
  );
}

export async function installPlugin(
  id: string,
  roles?: string[],
): Promise<void> {
  await api.post(
    `${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}/install`,
    roles && roles.length > 0 ? { roles } : {},
  );
}

export async function uninstallPlugin(id: string): Promise<void> {
  await api.del(
    `${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}/install`,
  );
}

export async function fetchMembers(): Promise<WorkspaceMember[]> {
  return parseMembers(await api.get<unknown>(`${WORKSPACE_API_BASE}/members`));
}

export async function updateMemberRoles(
  subject: string,
  productRoles: WorkspaceMember["productRoles"],
): Promise<void> {
  await api.put(
    `${WORKSPACE_API_BASE}/members/${encodeURIComponent(subject)}`,
    { productRoles },
  );
}

export async function fetchWorkspaceAccess(): Promise<WorkspaceAccess> {
  const result = await api.get<WorkspaceAccess>(`${WORKSPACE_API_BASE}/access`);
  if (
    !Array.isArray(result.products) ||
    !Array.isArray(result.modules) ||
    !result.productRoles ||
    typeof result.isOrganizationAdmin !== "boolean" ||
    result.products.some((product) => !isWorkspaceProduct(product))
  )
    throw new Error("Invalid workspace access response");
  return result;
}

export async function fetchTokens(): Promise<WorkspaceTokenMetadata[]> {
  return parseTokens(await api.get<unknown>(`${WORKSPACE_API_BASE}/tokens`));
}

export interface MintedToken {
  token: string;
  metadata: WorkspaceTokenMetadata;
}

export async function mintToken(input: {
  product: WorkspaceProduct;
  name: string;
  expiresInDays?: number;
}): Promise<MintedToken> {
  const payload = await api.post<unknown>(
    `${WORKSPACE_API_BASE}/tokens`,
    input,
  );
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { token?: unknown }).token !== "string" ||
    !(payload as { token: string }).token
  ) {
    throw new Error(
      "The capability service did not return the one-time runtime token.",
    );
  }
  const node = payload as Record<string, unknown>;
  if (!isWorkspaceProduct(node.product)) {
    throw new Error(
      "The capability service returned an invalid token product.",
    );
  }
  const metadata: WorkspaceTokenMetadata = {
    id: String(node.id ?? ""),
    product: node.product,
    name: String(node.name ?? input.name),
    tokenPrefix: String(node.tokenPrefix ?? ""),
    createdAt: String(node.createdAt ?? ""),
    expiresAt: String(node.expiresAt ?? ""),
    ...(typeof node.revokedAt === "string"
      ? { revokedAt: node.revokedAt }
      : {}),
    ...(typeof node.lastUsedAt === "string"
      ? { lastUsedAt: node.lastUsedAt }
      : {}),
  };
  if (
    !metadata.id ||
    !metadata.tokenPrefix ||
    !metadata.createdAt ||
    !metadata.expiresAt
  ) {
    throw new Error(
      "The capability service returned incomplete token metadata.",
    );
  }
  return { token: (payload as { token: string }).token, metadata };
}

export async function revokeToken(id: string): Promise<void> {
  await api.del(`${WORKSPACE_API_BASE}/tokens/${encodeURIComponent(id)}`);
}

/** Fetch one runtime widget's data through DX (never through the product API). */
export async function fetchWidgetData(
  installedId: string,
  widget: Pick<WorkspaceWidget, "id" | "type">,
  params: {
    limit?: number;
    offset?: number;
    search?: string;
    status?: string;
    sortBy?: string;
    sortDirection?: string;
  } = {},
  actionId?: string,
): Promise<WidgetData> {
  if (
    widget.type !== "metric" &&
    widget.type !== "table" &&
    widget.type !== "chart" &&
    widget.type !== "list" &&
    widget.type !== "map" &&
    widget.type !== "kanban" &&
    widget.type !== "timeline"
  ) {
    throw new Error("Only metric and table widgets have a data endpoint.");
  }
  const payload = await api.get<unknown>(
    installedWidgetDataPath(installedId, widget.id),
    {
      params: { ...params, ...(actionId ? { action: actionId } : {}) },
    },
  );
  return parseWidgetData(payload, widget.type);
}

export interface ReferenceOptions {
  items: Array<{ value: string; label: string }>;
  total: number;
  limit: number;
  offset: number;
}
export async function fetchReferenceOptions(installedId: string, widgetId: string, field: string, actionId: string, params: Record<string, unknown> = {}): Promise<ReferenceOptions> {
  return api.get<ReferenceOptions>(`${WORKSPACE_API_BASE}/installed/${encodeURIComponent(installedId)}/widgets/${encodeURIComponent(widgetId)}/options/${encodeURIComponent(field)}`, { params: { ...params, action: actionId } });
}

/**
 * Forms execute the bound same-organization workflow artifact through DX.
 * The endpoint accepts only declared fields at the top level. There is no
 * Tier-3 call and no fallback: a refused capability build surfaces its error.
 */
export async function executeFormWidget(
  installedId: string,
  widgetId: string,
  values: Record<string, unknown>,
  actionId?: string,
): Promise<unknown> {
  const receipt: any = await api.post<unknown>(
    `${installedWidgetExecutePath(installedId, widgetId)}${actionId ? `?action=${encodeURIComponent(actionId)}` : ""}`,
    { values },
  );
  if (receipt.completed) return receipt;
  const status = receipt.execution?.status;
  if (status === "success") return { ...receipt, completed: true, result: receipt.execution.output };
  if (["error", "cancelled"].includes(status)) throw new Error(receipt.execution.error || "Workflow did not complete");
  if (!receipt.executionId || !actionId) return receipt;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise(resolve => window.setTimeout(resolve, 1000));
    const progress: any = await api.get(`${WORKSPACE_API_BASE}/installed/${encodeURIComponent(installedId)}/widgets/${encodeURIComponent(widgetId)}/executions/${encodeURIComponent(receipt.executionId)}?action=${encodeURIComponent(actionId)}`);
    if (["error", "cancelled"].includes(progress.status)) throw new Error(progress.error || "Workflow did not complete");
    if (progress.completed) return { ...receipt, ...progress };
    if (progress.status === "paused") return { ...receipt, ...progress };
  }
  return { ...receipt, status: "pending", completed: false };

}

export async function fetchWorkflowReadiness(): Promise<WorkflowReadiness> {
  return parseWorkflowReadiness(
    await api.get<unknown>(`${WORKFLOW_ARTIFACTS_API}/readiness`),
  );
}

export async function fetchWorkflowArtifacts(): Promise<
  WorkflowArtifactSummary[]
> {
  return parseWorkflowArtifacts(await api.get<unknown>(WORKFLOW_ARTIFACTS_API));
}

export async function uploadWidgetFile(installedId: string, widgetId: string, actionId: string, file: File): Promise<{ id: string; filename: string }> {
  const { data } = await httpClient.post(`${WORKSPACE_API_BASE}/installed/${encodeURIComponent(installedId)}/widgets/${encodeURIComponent(widgetId)}/upload?action=${encodeURIComponent(actionId)}`, file, {
    headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
  });
  return data;
}
export async function downloadWidgetFile(installedId: string, widgetId: string, actionId: string, values: Record<string, unknown>): Promise<Blob> {
  const { data } = await httpClient.post(`${WORKSPACE_API_BASE}/installed/${encodeURIComponent(installedId)}/widgets/${encodeURIComponent(widgetId)}/download?action=${encodeURIComponent(actionId)}`, { values }, { responseType: "blob" });
  return data;
}
