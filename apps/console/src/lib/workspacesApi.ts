// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Same-origin HTTP binding for workspace plugins and workflow artifacts.
 * Every request uses the verified DX bearer session from `httpClient`; the
 * console never derives a product URL from a plugin schema.
 */
import { api } from './api';
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
  type WorkspacePlugin,
  type WorkspaceProduct,
  type WorkspaceTokenMetadata,
  type WorkspaceWidget,
} from './workspaces';

export interface PluginWriteBody {
  product: WorkspaceProduct;
  name: string;
  slug: string;
  audience: 'admin' | 'member';
  roles: string[];
  widgets: WorkspaceWidget[];
  version?: number;
}

export async function fetchCatalog(): Promise<WorkspaceCatalog> {
  return parseWorkspaceCatalog(await api.get<unknown>(`${WORKSPACE_API_BASE}/catalog`));
}

export async function fetchPlugins(product: WorkspaceProduct): Promise<WorkspacePlugin[]> {
  const payload = await api.get<unknown>(
    `${WORKSPACE_API_BASE}/plugins?product=${encodeURIComponent(product)}`,
  );
  return parsePluginList(payload);
}

export async function createPlugin(body: PluginWriteBody): Promise<WorkspacePlugin> {
  return parsePlugin(await api.post<unknown>(`${WORKSPACE_API_BASE}/plugins`, body));
}

export async function updatePlugin(id: string, body: PluginWriteBody): Promise<WorkspacePlugin> {
  return parsePlugin(
    await api.put<unknown>(`${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}`, body),
  );
}

export async function publishPlugin(id: string, version?: number): Promise<WorkspacePlugin> {
  return parsePlugin(
    await api.post<unknown>(
      `${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}/publish`,
      version === undefined ? {} : { version },
    ),
  );
}

export async function unpublishPlugin(id: string, version?: number): Promise<WorkspacePlugin> {
  return parsePlugin(
    await api.post<unknown>(
      `${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}/unpublish`,
      version === undefined ? {} : { version },
    ),
  );
}

export async function exportPluginBundle(id: string, options: { draft?: boolean } = {}): Promise<unknown> {
  const suffix = options.draft ? '?draft=1' : '';
  return api.get<unknown>(`${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}/export${suffix}`);
}

/**
 * Build the immutable, repository-tracked artifact for the plugin's Tier-3
 * product. The server refuses drafts and returns the exact bundle the Tier-3
 * sync CLI validates.
 */
export async function buildPluginBundle(id: string): Promise<unknown> {
  return api.get<unknown>(`${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}/build`);
}

export async function importPluginBundle(bundle: PluginBundle): Promise<WorkspacePlugin> {
  return parsePlugin(await api.post<unknown>(`${WORKSPACE_API_BASE}/import`, bundle));
}

/**
 * Member runtime list. This endpoint is role-filtered by the server; it is
 * never used to infer organization installation state in the admin console.
 */
export async function fetchInstalled(): Promise<InstalledPlugin[]> {
  return parseInstalledList(await api.get<unknown>(`${WORKSPACE_API_BASE}/installed`));
}

export async function installPlugin(id: string, roles?: string[]): Promise<void> {
  await api.post(
    `${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}/install`,
    roles && roles.length > 0 ? { roles } : {},
  );
}

export async function uninstallPlugin(id: string): Promise<void> {
  await api.del(`${WORKSPACE_API_BASE}/plugins/${encodeURIComponent(id)}/install`);
}

export async function fetchMembers(): Promise<WorkspaceMember[]> {
  return parseMembers(await api.get<unknown>(`${WORKSPACE_API_BASE}/members`));
}

export async function updateMemberRoles(subject: string, roles: string[]): Promise<void> {
  await api.put(`${WORKSPACE_API_BASE}/members/${encodeURIComponent(subject)}`, { roles });
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
  const payload = await api.post<unknown>(`${WORKSPACE_API_BASE}/tokens`, input);
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as { token?: unknown }).token !== 'string' ||
    !(payload as { token: string }).token
  ) {
    throw new Error('The capability service did not return the one-time runtime token.');
  }
  const node = payload as Record<string, unknown>;
  if (!isWorkspaceProduct(node.product)) {
    throw new Error('The capability service returned an invalid token product.');
  }
  const metadata: WorkspaceTokenMetadata = {
    id: String(node.id ?? ''),
    product: node.product,
    name: String(node.name ?? input.name),
    tokenPrefix: String(node.tokenPrefix ?? ''),
    createdAt: String(node.createdAt ?? ''),
    expiresAt: String(node.expiresAt ?? ''),
    ...(typeof node.revokedAt === 'string' ? { revokedAt: node.revokedAt } : {}),
    ...(typeof node.lastUsedAt === 'string' ? { lastUsedAt: node.lastUsedAt } : {}),
  };
  if (!metadata.id || !metadata.tokenPrefix || !metadata.createdAt || !metadata.expiresAt) {
    throw new Error('The capability service returned incomplete token metadata.');
  }
  return { token: (payload as { token: string }).token, metadata };
}

export async function revokeToken(id: string): Promise<void> {
  await api.del(`${WORKSPACE_API_BASE}/tokens/${encodeURIComponent(id)}`);
}

/** Fetch one runtime widget's data through DX (never through the product API). */
export async function fetchWidgetData(
  installedId: string,
  widget: Pick<WorkspaceWidget, 'id' | 'type'>,
): Promise<WidgetData> {
  if (widget.type !== 'metric' && widget.type !== 'table') {
    throw new Error('Only metric and table widgets have a data endpoint.');
  }
  const payload = await api.get<unknown>(installedWidgetDataPath(installedId, widget.id), {
    params: { limit: 50 },
  });
  return parseWidgetData(payload, widget.type);
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
): Promise<unknown> {
  return api.post<unknown>(installedWidgetExecutePath(installedId, widgetId), { values });
}

export async function fetchWorkflowReadiness(): Promise<WorkflowReadiness> {
  return parseWorkflowReadiness(await api.get<unknown>(`${WORKFLOW_ARTIFACTS_API}/readiness`));
}

export async function fetchWorkflowArtifacts(): Promise<WorkflowArtifactSummary[]> {
  return parseWorkflowArtifacts(await api.get<unknown>(WORKFLOW_ARTIFACTS_API));
}
