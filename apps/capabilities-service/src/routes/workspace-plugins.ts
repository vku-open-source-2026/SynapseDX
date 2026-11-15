import {
  actionGovernanceErrors,
  registeredBinding,
  actionPayloadError,
  type StudioAction,
} from "../studio-actions";
import {
  callCommon,
  callCommonBytes,
  fileTypeAccepted,
  COMMON_SOURCES,
  commonSource,
  commonRows,
  commonDetail,
  commonAction,
  validateCommonValues,
} from "../common-builder";
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Organization-installed low-code workspace plugins (Tier 2 only).
 *
 * - Management is gated by a **verified** organization administrator
 *   (`principal.isDxAdmin`, resolved by `auth.ts` from Tier-1 IAM
 *   `user.is_org_admin`); scopes, roles in a token or request bodies never
 *   grant plugin administration.
 * - Every organization owns its plugins, installations, member roles and
 *   runtime tokens under the org-first tenant; cross-tenant reads return 404.
 * - Consumers read immutable published snapshots, never the editable draft.
 * - Widget data reads go through the Tier-2 dataset records and the exact
 *   product-resource allowlist. DX never calls Tier 3.
 * - Form execution is only possible when the form is bound to an
 *   organization-owned workflow artifact managed by DX; the Tier-1 workflow is
 *   executed with the caller's own verified credential.
 */
import express, { Express, Request } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { SynapseOneClient } from "@synapseone/sdk";
import {
  Caller,
  CallerPrincipal,
  authenticate,
  requireAuthenticated,
} from "../auth";
import { ServiceConfig } from "../config";
import { apiError } from "../errors";
import { handler } from "../http";
import { parsePagination, setPageHeaders } from "../pagination";
import {
  COLLECTIONS,
  CapabilityRecord,
  correlationIdOf,
  getDocumentOrNull,
  isConflict,
  isNotFound,
  queryDocuments,
  recordAudit,
  serviceClient,
} from "../platform";
import { loadDataset, type DatasetDocument } from "../publication";
import { TtlCache } from "../ttl-cache";
import {
  WIDGET_TYPES,
  ADMIN_TIER_ROLES,
  MEMBER_ROLES,
  PRODUCT_RESOURCES,
  PUBLIC_ROLES,
  TOKEN_PREFIX,
  WIDGET_ACTIONS,
  WorkspaceInstallRecord,
  WorkspaceLimits,
  WorkspaceMemberRecord,
  WorkspacePluginRecord,
  WorkspaceSnapshotRecord,
  WorkspaceTokenRecord,
  WorkspaceWidget,
  WidgetAction,
  buildBundle,
  canonicalPluginSource,
  checksumOf,
  effectiveRoles,
  hashWorkspaceToken,
  intersectRoles,
  isValidWorkspaceTokenShape,
  normalizeMemberRoles,
  normalizeRoles,
  parseBundle,
  parsePluginDefinition,
  parseSource,
  pluginView,
  portableDefinition,
  publishedView,
  requireBuildSource,
  requireWorkspaceOrganization,
  requireWorkspaceProduct,
  resourceFor,
  tokenHashMatches,
  tokenIsUsable,
  tokenMetadata,
  tokenPrefixOf,
  workspaceDocId,
  workspaceLimits,
  workspaceTenant,
} from "../workspace-plugins";
import { PRODUCT_ROLES } from "../workspace-plugins";
import {
  memberModules,
  parseProductRoles,
  productRolesForMember,
  workspaceAccess,
} from "../workspace-access";
import {
  readPluginExecution,
  executeWorkflowArtifactForPlugin,
  getWorkflowArtifactExecutionReadiness,
  getWorkflowArtifactOrgReadiness,
} from "./workflow-artifacts";

/** Owned by the DX workflow capability (same Tier-1 collection, read-only here). */
const WORKFLOW_ARTIFACT_COLLECTION = "synapsedx_capability_workflow_artifacts";

const PLUGIN_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const MEMBER_SUBJECT_RE = /^[A-Za-z0-9_.@:-]{1,128}$/;
const WORKFLOW_ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{8,120}$/;
const WORKFLOW_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const FORM_TEXT_MAX = 4000;
const REVISION_HISTORY_LIMIT = 25;

const WORKSPACE_COLLECTIONS = [
  COLLECTIONS.workspacePlugins,
  COLLECTIONS.workspacePluginSnapshots,
  COLLECTIONS.workspacePluginRevisions,
  COLLECTIONS.workspaceInstalls,
  COLLECTIONS.workspaceMembers,
  COLLECTIONS.workspaceTokens,
];

/**
 * Read-through projections for a console page load. Every widget request
 * previously re-listed every install and re-read every plugin/snapshot from
 * Tier-1; a 15-widget page could issue hundreds of upstream reads and trip the
 * edge rate limit. These caches are short-lived, tenant-keyed and explicitly
 * invalidated by the mutation paths below. They are not a database.
 */
const CACHE_READS = process.env.NODE_ENV !== "test";
const cacheTtl = (milliseconds: number): number =>
  CACHE_READS ? milliseconds : 0;
const memberRolesCache = new TtlCache<string[]>(cacheTtl(5_000), 1_000);
const installCache = new TtlCache<WorkspaceInstallRecord>(
  cacheTtl(5_000),
  1_000,
);
const installListCache = new TtlCache<Map<string, WorkspaceInstallRecord>>(
  cacheTtl(3_000),
  100,
);
const pluginCache = new TtlCache<PluginDocument>(cacheTtl(3_000), 500);
const snapshotCache = new TtlCache<WorkspaceSnapshotRecord>(
  cacheTtl(60_000),
  1_000,
);
const datasetCache = new TtlCache<DatasetDocument>(cacheTtl(3_000), 200);

/** Require a binding in the immutable published registry. */
function requireRegisteredAction(
  widgets: Parameters<typeof registeredBinding>[0],
  actionId: unknown,
  target: string,
  kind: "query" | "mutation" | "upload" | "download",
): StudioAction {
  const op = registeredBinding(widgets, actionId, target, kind);
  if (!op)
    throw apiError(
      403,
      "action_not_registered",
      "This binding requires a declared action in the published page",
    );
  return op;
}
/** Apply the same declared input contract to collection and reference queries. */
function queryInput(req: Request, op: StudioAction) {
  const allowed = new Set(["action", "limit", "offset", "search", "status", "sortBy", "sortDirection"]);
  if (Object.keys(req.query).some(key => !allowed.has(key)))
    throw apiError(400, "query_input_invalid", "Undeclared query parameter");
  for (const [key, value] of Object.entries(req.query))
    if (typeof value !== "string" || value.length > 200)
      throw apiError(400, "query_input_invalid", `Invalid query value ${key}`);
  const input = Object.fromEntries(Object.entries(req.query)
    .filter(([key]) => key !== "action")
    .map(([key, value]) => [key, ["limit", "offset"].includes(key) ? Number(value) : value]));
  const issue = actionPayloadError(op, input);
  if (issue) throw apiError(400, "query_input_invalid", issue);
  return input;
}
/** Test-only: clear workspace read-through caches between harnesses. */
export function resetWorkspaceCachesForTests(): void {
  memberRolesCache.clear();
  installCache.clear();
  installListCache.clear();
  pluginCache.clear();
  snapshotCache.clear();
  datasetCache.clear();
}

async function loadWorkspaceDataset(
  client: SynapseOneClient,
  id: string,
): Promise<DatasetDocument | null> {
  const cached = datasetCache.get(id);
  if (cached) return cached;
  const found = await loadDataset(client, id);
  if (found) datasetCache.set(id, found);
  return found;
}

function invalidateWorkspaceCaches(tenant: string, pluginId?: string): void {
  memberRolesCache.deletePrefix(`${tenant}:`);
  installListCache.deletePrefix(`${tenant}:`);
  if (pluginId) {
    pluginCache.delete(`${tenant}:${pluginId}`);
    installCache.delete(`${tenant}:${pluginId}`);
  } else {
    pluginCache.deletePrefix(`${tenant}:`);
    installCache.deletePrefix(`${tenant}:`);
  }
  snapshotCache.deletePrefix(`${tenant}:`);
}

interface WorkspaceContext {
  caller: Caller;
  principal: CallerPrincipal;
  client: SynapseOneClient;
  tenant: string;
  limits: WorkspaceLimits;
}

interface PluginDocument {
  record: WorkspacePluginRecord;
  version: number;
}

interface InstalledEntry {
  snapshot: WorkspaceSnapshotRecord;
  install: WorkspaceInstallRecord;
  effectiveRoles: string[];
}

/* ------------------------------------------------------------------------- *
 * Context / guards
 * ------------------------------------------------------------------------- */

function assertUserSession(principal: CallerPrincipal): void {
  if (principal.type !== "jwt") {
    throw apiError(
      403,
      "user_token_required",
      "this endpoint requires a verified user bearer token",
    );
  }
  if (principal.kind && principal.kind !== "user") {
    throw apiError(
      403,
      "user_token_required",
      "machine credentials cannot use the workspace surface",
    );
  }
}

async function workspaceContext(
  req: Request,
  config: ServiceConfig,
): Promise<WorkspaceContext> {
  const caller = await authenticate(req, config, true);
  const principal = requireAuthenticated(caller);
  assertUserSession(principal);
  return {
    caller,
    principal,
    client: serviceClient(config),
    tenant: workspaceTenant(principal),
    limits: workspaceLimits(),
  };
}

/**
 * Organization administrator gate.
 *
 * `isDxAdmin` is set by `auth.ts` only from Tier-1 IAM `user.is_org_admin`
 * (or the operator bootstrap list). A `*` user token is member authority, an
 * explicit `synapsedx:admin` machine scope is not organization ownership, and
 * an IAM role slug is not required because a real owner may have no role row.
 */
async function adminContext(
  req: Request,
  config: ServiceConfig,
): Promise<WorkspaceContext> {
  const context = await workspaceContext(req, config);
  requireWorkspaceOrganization(context.principal);
  if (context.principal.isDxAdmin !== true) {
    throw apiError(
      403,
      "admin_required",
      "a verified organization administrator is required for plugin management",
    );
  }
  // Every verified organization admin owns a membership row, so the DX
  // workspace and admin preview work without a second manual grant. This is
  // idempotent and never widens an existing membership's roles.
  await ensureAdminMembership(
    context.client,
    config,
    context.tenant,
    context.principal,
    req,
  );
  return context;
}

async function ensureWorkspaceCollections(
  client: SynapseOneClient,
): Promise<void> {
  for (const name of WORKSPACE_COLLECTIONS) {
    try {
      await client.base.getCollection(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await client.base.createCollection({
          name,
          description: `SynapseDX workspace plugin ${name}`,
        });
      } catch (createError) {
        if (!isConflict(createError)) throw createError;
      }
    }
  }
}

function assertBodyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length) {
    throw apiError(
      400,
      "invalid_plugin",
      `request has unsupported field(s): ${extra.slice(0, 8).join(", ")}`,
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Storage helpers
 * ------------------------------------------------------------------------- */

function pluginDocumentId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!PLUGIN_ID_RE.test(id))
    throw apiError(404, "plugin_not_found", "plugin not found");
  return id;
}

function snapshotDocumentId(pluginId: string, version: number): string {
  return workspaceDocId("ws-snap", pluginId, String(version));
}

function revisionDocumentId(pluginId: string, version: number): string {
  return workspaceDocId("ws-rev", pluginId, String(version));
}

function installDocumentId(tenant: string, pluginId: string): string {
  return workspaceDocId("ws-install", tenant, pluginId);
}

function memberDocumentId(tenant: string, subject: string): string {
  return workspaceDocId("ws-member", tenant, subject);
}

async function loadPlugin(
  client: SynapseOneClient,
  tenant: string,
  id: string,
): Promise<PluginDocument> {
  const cacheKey = `${tenant}:${id}`;
  const cached = pluginCache.get(cacheKey);
  if (cached) return cached;
  const document = await getDocumentOrNull<WorkspacePluginRecord>(
    client,
    COLLECTIONS.workspacePlugins,
    id,
  );
  if (!document || document.data.tenant !== tenant)
    throw apiError(404, "plugin_not_found", "plugin not found");
  const value = { record: document.data, version: document.version };
  pluginCache.set(cacheKey, value);
  return value;
}

async function loadSnapshot(
  client: SynapseOneClient,
  tenant: string,
  pluginId: string,
  version: number | undefined,
): Promise<WorkspaceSnapshotRecord | null> {
  if (version === undefined) return null;
  const cacheKey = `${tenant}:${pluginId}:${version}`;
  const cached = snapshotCache.get(cacheKey);
  if (cached) return cached;
  const document = await getDocumentOrNull<WorkspaceSnapshotRecord>(
    client,
    COLLECTIONS.workspacePluginSnapshots,
    snapshotDocumentId(pluginId, version),
  );
  if (!document || document.data.tenant !== tenant) return null;
  snapshotCache.set(cacheKey, document.data);
  return document.data;
}

async function loadInstall(
  client: SynapseOneClient,
  tenant: string,
  pluginId: string,
): Promise<WorkspaceInstallRecord | null> {
  const cacheKey = `${tenant}:${pluginId}`;
  const cached = installCache.get(cacheKey);
  if (cached) return cached;
  const document = await getDocumentOrNull<WorkspaceInstallRecord>(
    client,
    COLLECTIONS.workspaceInstalls,
    installDocumentId(tenant, pluginId),
  );
  if (!document || document.data.tenant !== tenant) return null;
  installCache.set(cacheKey, document.data);
  return document.data;
}

async function listInstalls(
  client: SynapseOneClient,
  tenant: string,
): Promise<Map<string, WorkspaceInstallRecord>> {
  const cached = installListCache.get(tenant);
  if (cached) return cached;
  const result = await queryDocuments<WorkspaceInstallRecord>(
    client,
    COLLECTIONS.workspaceInstalls,
    {
      where: { tenant },
      limit: 1000,
    },
  );
  const map = new Map<string, WorkspaceInstallRecord>();
  for (const item of result.items) {
    if (item.data.tenant === tenant) map.set(item.data.pluginId, item.data);
  }
  installListCache.set(tenant, map);
  return map;
}

async function loadMember(
  client: SynapseOneClient,
  tenant: string,
  subject: string,
): Promise<WorkspaceMemberRecord | null> {
  const document = await getDocumentOrNull<WorkspaceMemberRecord>(
    client,
    COLLECTIONS.workspaceMembers,
    memberDocumentId(tenant, subject),
  );
  if (!document || document.data.tenant !== tenant) return null;
  return document.data;
}

/**
 * Bootstrap the verified organization administrator into the member table so
 * the organization owner can open the DX workspace without a second manual
 * grant. Only `isDxAdmin` (IAM org admin) can trigger this; it never widens an
 * existing membership row.
 */
async function ensureAdminMembership(
  client: SynapseOneClient,
  config: ServiceConfig,
  tenant: string,
  principal: CallerPrincipal,
  req: Request,
): Promise<WorkspaceMemberRecord | null> {
  const existing = await loadMember(client, tenant, principal.subject);
  if (existing) return existing;
  if (principal.isDxAdmin !== true) return null;
  const now = new Date().toISOString();
  const record: WorkspaceMemberRecord = {
    id: memberDocumentId(tenant, principal.subject),
    tenant,
    ...(principal.org ? { org: principal.org } : {}),
    subject: principal.subject,
    roles: ["admin"],
    updatedBy: "system:iam-org-admin",
    createdAt: now,
    updatedAt: now,
  };
  try {
    await ensureWorkspaceCollections(client);
    await client.base.createDocument(COLLECTIONS.workspaceMembers, {
      id: record.id,
      data: record as unknown as Record<string, unknown>,
    });
  } catch (error) {
    if (!isConflict(error)) throw error;
    const raced = await loadMember(client, tenant, principal.subject);
    if (raced) return raced;
    throw error;
  }
  await recordAudit(client, config, {
    actor: principal.subject,
    tenant,
    action: "workspace.member.bootstrap",
    correlationId: correlationIdOf(req),
    details: {
      subject: principal.subject,
      roles: ["admin"],
      source: "iam-org-admin",
    },
  });
  return record;
}

async function memberRolesFor(
  client: SynapseOneClient,
  config: ServiceConfig,
  tenant: string,
  principal: CallerPrincipal,
  req: Request,
  product: WorkspacePluginRecord["product"],
): Promise<string[]> {
  let member = await loadMember(client, tenant, principal.subject);
  if (!member && principal.isDxAdmin === true)
    member = await ensureAdminMembership(
      client,
      config,
      tenant,
      principal,
      req,
    );
  return productRolesForMember(member, principal)[product] || [];
}

/* ------------------------------------------------------------------------- *
 * Workflow artifact binding
 * ------------------------------------------------------------------------- */

interface WorkflowArtifactRecordLike {
  id: string;
  tenant: string;
  name?: string;
  slug?: string;
  checksum?: string;
  portableChecksum?: string;
  revision?: number;
  workflowRevision?: number;
  workflowId?: string;
  managedBy?: "technical" | "user";
  settings?: Record<string, unknown>;
}

async function loadArtifact(
  client: SynapseOneClient,
  tenant: string,
  id: string,
): Promise<WorkflowArtifactRecordLike | null> {
  if (!WORKFLOW_ARTIFACT_ID_RE.test(id)) return null;
  const document = await getDocumentOrNull<WorkflowArtifactRecordLike>(
    client,
    WORKFLOW_ARTIFACT_COLLECTION,
    id,
  );
  if (!document || document.data.tenant !== tenant) return null;
  return document.data;
}

/** Every bound form must reference an artifact owned by the same organization. */
async function assertArtifactBindings(
  client: SynapseOneClient,
  tenant: string,
  widgets: readonly WorkspaceWidget[],
): Promise<void> {
  for (const widget of widgets) {
    if (widget.type !== "form" || !widget.workflowArtifactId) continue;
    const artifact = await loadArtifact(
      client,
      tenant,
      widget.workflowArtifactId,
    );
    if (!artifact) {
      throw apiError(
        409,
        "workflow_artifact_not_found",
        "the bound workflow artifact does not belong to this organization",
        {
          widgetId: widget.id,
        },
      );
    }
    if (!artifact.workflowId || !WORKFLOW_ID_RE.test(artifact.workflowId)) {
      throw apiError(
        409,
        "workflow_artifact_not_found",
        "the bound workflow artifact has no executable Tier-1 workflow",
        {
          widgetId: widget.id,
        },
      );
    }
    if (!artifactIsProtected(artifact)) {
      throw apiError(
        409,
        "workflow_not_protected",
        "the bound workflow artifact must be a technical-identity owner-only workflow",
        {
          widgetId: widget.id,
          managedBy: artifact.managedBy || "user",
          accessMode: artifactAccessMode(artifact.settings),
        },
      );
    }
  }
}

async function artifactRefsFor(
  client: SynapseOneClient,
  tenant: string,
  widgets: readonly WorkspaceWidget[],
): Promise<Map<string, { name: string; slug?: string; checksum?: string }>> {
  const refs = new Map<
    string,
    { name: string; slug?: string; checksum?: string }
  >();
  for (const widget of widgets) {
    if (widget.type !== "form" || !widget.workflowArtifactId) continue;
    const artifact = await loadArtifact(
      client,
      tenant,
      widget.workflowArtifactId,
    );
    if (!artifact) {
      throw apiError(
        409,
        "workflow_artifact_not_found",
        "a bound workflow artifact no longer exists",
        { widgetId: widget.id },
      );
    }
    refs.set(widget.workflowArtifactId, {
      name: String(artifact.name || artifact.id).slice(0, 160),
      ...(artifact.slug ? { slug: artifact.slug } : {}),
      ...(artifact.portableChecksum &&
      /^[a-f0-9]{64}$/.test(artifact.portableChecksum)
        ? { checksum: artifact.portableChecksum }
        : artifact.checksum && /^[a-f0-9]{64}$/.test(artifact.checksum)
          ? { checksum: artifact.checksum }
          : {}),
    });
  }
  return refs;
}

/**
 * Rebind portable `workflowRef`s to the importing organization's artifacts.
 * The bundle intentionally carries no environment-specific artifact id.
 */
async function resolveArtifactRefs(
  client: SynapseOneClient,
  tenant: string,
  widgets: readonly WorkspaceWidget[],
): Promise<WorkspaceWidget[]> {
  if (!widgets.some((widget) => widget.workflowRef)) return [...widgets];
  const result = await queryDocuments<WorkflowArtifactRecordLike>(
    client,
    WORKFLOW_ARTIFACT_COLLECTION,
    {
      where: { tenant },
      limit: 1000,
    },
  );
  const artifacts = result.items
    .map((item) => item.data)
    .filter((item) => item.tenant === tenant);
  return widgets.map((widget) => {
    if (widget.type !== "form" || !widget.workflowRef) return widget;
    const ref = widget.workflowRef;
    let matches = artifacts.filter((artifact) =>
      ref.slug
        ? artifact.slug === ref.slug
        : String(artifact.name || "") === ref.name,
    );
    if (ref.checksum) {
      matches = matches.filter(
        (artifact) =>
          (artifact.portableChecksum || artifact.checksum) === ref.checksum,
      );
    }
    if (matches.length === 0) {
      throw apiError(
        409,
        "workflow_artifact_not_found",
        "import the referenced workflow artifact before this plugin",
        {
          widgetId: widget.id,
          ref,
        },
      );
    }
    if (matches.length > 1) {
      throw apiError(
        409,
        "workflow_artifact_ambiguous",
        "more than one workflow artifact matches the reference",
        {
          widgetId: widget.id,
          ref,
        },
      );
    }
    const { workflowRef: _ref, ...rest } = widget;
    return { ...rest, workflowArtifactId: matches[0].id };
  });
}

function artifactAccessMode(
  settings: Record<string, unknown> | undefined,
): "owner-only" | "legacy" | "unsupported" {
  if (!settings || typeof settings !== "object") return "legacy";
  const access = settings.access;
  if (access === undefined) return "legacy";
  if (!access || typeof access !== "object" || Array.isArray(access))
    return "unsupported";
  const mode = (access as Record<string, unknown>).mode;
  if (mode === undefined || mode === "owner-only") return "owner-only";
  return "unsupported";
}

/**
 * Mirror the workflow capability's plugin-execution invariant: only a
 * technical-identity, review-protected (owner-only) artifact may run a form.
 */
function artifactIsProtected(
  artifact: WorkflowArtifactRecordLike | null | undefined,
): boolean {
  return Boolean(
    artifact &&
    artifact.managedBy === "technical" &&
    artifactAccessMode(artifact.settings) === "owner-only",
  );
}

function isPinnedArtifactMatch(
  widget: WorkspaceWidget,
  artifact: WorkflowArtifactRecordLike | null | undefined,
): boolean {
  if (!artifact) return false;
  if (
    widget.workflowArtifactRevision === undefined ||
    !widget.workflowArtifactChecksum
  )
    return false;
  return (
    artifact.revision === widget.workflowArtifactRevision &&
    typeof artifact.checksum === "string" &&
    artifact.checksum === widget.workflowArtifactChecksum
  );
}

/**
 * Copy server-owned pins into the widgets that become the published snapshot.
 * The draft record never stores pins, so an artifact edit cannot silently
 * change an already published layout.
 */
async function pinArtifactBindings(
  client: SynapseOneClient,
  tenant: string,
  widgets: readonly WorkspaceWidget[],
): Promise<WorkspaceWidget[]> {
  const pinned: WorkspaceWidget[] = [];
  for (const widget of widgets) {
    if (widget.type !== "form" || !widget.workflowArtifactId) {
      pinned.push(widget);
      continue;
    }
    const artifact = await loadArtifact(
      client,
      tenant,
      widget.workflowArtifactId,
    );
    if (
      !artifact ||
      !artifact.workflowId ||
      !WORKFLOW_ID_RE.test(artifact.workflowId)
    ) {
      throw apiError(
        409,
        "workflow_artifact_not_found",
        "the bound workflow artifact is not executable",
        { widgetId: widget.id },
      );
    }
    if (!artifactIsProtected(artifact)) {
      throw apiError(
        409,
        "workflow_not_protected",
        "the bound workflow artifact must be a technical-identity owner-only workflow",
        {
          widgetId: widget.id,
          managedBy: artifact.managedBy || "user",
          accessMode: artifactAccessMode(artifact.settings),
        },
      );
    }
    if (
      !Number.isInteger(artifact.revision) ||
      (artifact.revision as number) < 1 ||
      !/^[a-f0-9]{64}$/.test(String(artifact.checksum || ""))
    ) {
      throw apiError(
        409,
        "workflow_artifact_unpinned",
        "the bound workflow artifact has no revision/checksum to pin",
        { widgetId: widget.id },
      );
    }
    pinned.push({
      ...widget,
      workflowArtifactRevision: artifact.revision as number,
      workflowArtifactChecksum: String(artifact.checksum),
      workflowArtifactPortableChecksum: String(
        artifact.portableChecksum || artifact.checksum,
      ),
    });
  }
  return pinned;
}

/** Public widget view: server-owned pins never leave the server. */
function publicWidget(widget: WorkspaceWidget): WorkspaceWidget {
  const {
    workflowArtifactRevision: _revision,
    workflowArtifactChecksum: _checksum,
    workflowArtifactPortableChecksum: _portableChecksum,
    ...rest
  } = widget;
  return rest;
}

/* ------------------------------------------------------------------------- *
 * Views
 * ------------------------------------------------------------------------- */

export interface WorkspaceOrgReadinessView {
  ready: boolean;
  reason?: string;
  requirement: string;
  configured: boolean;
  verified: boolean;
}

/** Per-org technical workflow identity readiness (never a global SDK claim). */
async function orgReadinessFor(
  config: ServiceConfig,
  tenant: string,
): Promise<WorkspaceOrgReadinessView> {
  const readiness = await getWorkflowArtifactOrgReadiness(config, tenant);
  return {
    ready: readiness.ready,
    ...(readiness.reason ? { reason: readiness.reason } : {}),
    requirement: readiness.requirement,
    configured: readiness.configured,
    verified: readiness.verified,
  };
}

/** Avoid an IAM probe when the installed pages have no action widgets at all. */
async function readinessForEntries(
  config: ServiceConfig,
  tenant: string,
  entries: readonly InstalledEntry[],
): Promise<WorkspaceOrgReadinessView> {
  const hasForm = entries.some((entry) =>
    entry.snapshot.widgets.some((widget) => widget.type === "form"),
  );
  if (!hasForm) {
    return {
      ready: false,
      reason: "no_form_widgets",
      requirement: "No workflow-bound form is installed for this organization",
      configured: false,
      verified: false,
    };
  }
  return orgReadinessFor(config, tenant);
}

interface DecoratedWidget extends WorkspaceWidget {
  /** True only for an authorized form bound to a protected, pinned workflow. */
  canSubmit: boolean;
  /** Why the form is disabled (absent for non-action widgets). */
  canSubmitReason?: string;
}

interface SubmitState {
  canSubmit: boolean;
  reason?: string;
}

/**
 * Decide form submit readiness from server-verified facts only:
 * binding, protection, pins, membership roles, published SDK capability and the
 * per-organization technical identity. A globally ready SDK never implies org
 * readiness.
 */
function widgetSubmitState(
  widget: WorkspaceWidget,
  artifact: WorkflowArtifactRecordLike | null | undefined,
  roles: readonly string[],
  sdkReady: boolean,
  orgReadiness: WorkspaceOrgReadinessView,
): SubmitState {
  if (widget.type !== "form") return { canSubmit: false };
  const common = commonSource(widget.resource);
  if (common)
    return common.operations[widget.action || "create"] &&
      roles.some((role) => role !== "viewer") &&
      (![
        "commonPeople",
        "commonKpis",
        "commonAgents",
        "commonProcesses",
      ].includes(common.key) ||
        roles.some((role) => ["admin", "manager"].includes(role)))
      ? { canSubmit: true, reason: "capability_ready" }
      : { canSubmit: false, reason: "mutation_not_supported" };
  if (!widget.workflowArtifactId)
    return { canSubmit: false, reason: "workflow_artifact_unbound" };
  if (!artifact)
    return { canSubmit: false, reason: "workflow_artifact_missing" };
  if (!artifactIsProtected(artifact))
    return { canSubmit: false, reason: "workflow_artifact_not_protected" };
  if (
    widget.workflowArtifactRevision === undefined ||
    !widget.workflowArtifactChecksum
  ) {
    return { canSubmit: false, reason: "workflow_artifact_unpinned" };
  }
  if (!isPinnedArtifactMatch(widget, artifact)) {
    return { canSubmit: false, reason: "workflow_artifact_revision_mismatch" };
  }
  if (!roles.length)
    return { canSubmit: false, reason: "installation_role_missing" };
  if (!sdkReady)
    return { canSubmit: false, reason: "workflow_sdk_release_required" };
  if (!orgReadiness.ready)
    return {
      canSubmit: false,
      reason: orgReadiness.reason || "workflow_org_identity_unverified",
    };
  return { canSubmit: true, reason: "ready" };
}

/** Runtime tokens are machine credentials: layouts are readable, actions never submit. */
function decorateRuntimeWidgets(
  widgets: readonly WorkspaceWidget[],
): DecoratedWidget[] {
  return widgets.map((widget) => ({
    ...publicWidget(widget),
    canSubmit: false,
    ...(widget.type === "form"
      ? { canSubmitReason: "runtime_token_read_only" }
      : {}),
  }));
}

interface AdminPluginView extends ReturnType<typeof pluginView> {
  installed: boolean;
  installedRoles?: string[];
}

function adminPluginView(
  plugin: WorkspacePluginRecord,
  installs: Map<string, WorkspaceInstallRecord>,
): AdminPluginView {
  const install = installs.get(plugin.id);
  return {
    ...pluginView(plugin),
    installed: !!install,
    ...(install ? { installedRoles: [...install.roles] } : {}),
  };
}

/**
 * Turn an immutable published snapshot into the record shape the portable
 * bundle builder expects. Source provenance is deliberately supplied by the
 * caller: it describes a repository target, not the runtime layout.
 */
function publishedBuildRecord(
  plugin: WorkspacePluginRecord,
  snapshot: WorkspaceSnapshotRecord,
  source: WorkspacePluginRecord["source"],
): WorkspacePluginRecord {
  const { source: _previousSource, ...base } = plugin;
  return {
    ...base,
    name: snapshot.name,
    slug: snapshot.slug,
    audience: snapshot.audience,
    roles: [...snapshot.roles],
    widgets: snapshot.widgets,
    version: snapshot.version,
    checksum: snapshot.checksum,
    ...(source ? { source } : {}),
  };
}

interface InstalledView extends ReturnType<typeof publishedView> {
  roles: string[];
  widgets: DecoratedWidget[];
  installedAt: string;
  installationRoles: string[];
}

function installedView(
  entry: InstalledEntry,
  artifacts: Map<string, WorkflowArtifactRecordLike | null>,
  orgReadiness: WorkspaceOrgReadinessView,
): InstalledView {
  const sdkReady = getWorkflowArtifactExecutionReadiness().ready;
  const widgets = entry.snapshot.widgets.map((widget) => {
    const state = widgetSubmitState(
      widget,
      artifacts.get(widget.workflowArtifactId || ""),
      entry.effectiveRoles,
      sdkReady,
      orgReadiness,
    );
    return {
      ...publicWidget(widget),
      canSubmit: state.canSubmit,
      ...(state.reason ? { canSubmitReason: state.reason } : {}),
    };
  });
  return {
    ...publishedView(entry.snapshot),
    widgets,
    roles: [...entry.effectiveRoles],
    installedAt: entry.install.installedAt,
    installationRoles: [...entry.install.roles],
  };
}

async function loadArtifactMap(
  client: SynapseOneClient,
  tenant: string,
  entries: readonly InstalledEntry[],
): Promise<Map<string, WorkflowArtifactRecordLike | null>> {
  const ids = new Set<string>();
  for (const entry of entries) {
    for (const widget of entry.snapshot.widgets) {
      if (widget.type === "form" && widget.workflowArtifactId)
        ids.add(widget.workflowArtifactId);
    }
  }
  const map = new Map<string, WorkflowArtifactRecordLike | null>();
  for (const id of ids) map.set(id, await loadArtifact(client, tenant, id));
  return map;
}

async function installedEntries(
  client: SynapseOneClient,
  config: ServiceConfig,
  tenant: string,
  principal: CallerPrincipal,
  req: Request,
): Promise<InstalledEntry[]> {
  const grants = await workspaceAccess(client, tenant, principal);
  const installs = await listInstalls(client, tenant);
  const entries: InstalledEntry[] = [];
  for (const install of installs.values()) {
    const plugin = await getDocumentOrNull<WorkspacePluginRecord>(
      client,
      COLLECTIONS.workspacePlugins,
      install.pluginId,
    );
    if (!plugin || plugin.data.tenant !== tenant) continue;
    if (
      plugin.data.status !== "published" ||
      plugin.data.publishedVersion === undefined
    )
      continue;
    const snapshot = await loadSnapshot(
      client,
      tenant,
      plugin.data.id,
      plugin.data.publishedVersion,
    );
    if (!snapshot || snapshot.pluginId !== plugin.data.id) continue;
    const memberRoles = grants[snapshot.product] || [];
    const roles = effectiveRoles(memberRoles, install.roles, snapshot.roles);
    if (!roles.length) continue;
    if (
      snapshot.audience === "admin" &&
      !intersectRoles(memberRoles, ADMIN_TIER_ROLES).length
    )
      continue;
    entries.push({ snapshot, install, effectiveRoles: roles });
  }
  entries.sort((a, b) => a.snapshot.name.localeCompare(b.snapshot.name));
  return entries;
}

async function installedEntry(
  client: SynapseOneClient,
  config: ServiceConfig,
  tenant: string,
  principal: CallerPrincipal,
  req: Request,
  pluginId: string,
): Promise<InstalledEntry> {
  // Load exactly the requested install instead of every install owned by the
  // organization. A widget data request used to read all N plugins and
  // snapshots, which made a page with a dozen widgets exceed the Tier-1 edge
  // rate limit before the first render completed.
  const install = await loadInstall(client, tenant, pluginId);
  if (!install)
    throw apiError(
      404,
      "plugin_not_installed",
      "this plugin is not installed for your organization",
    );
  const plugin = await loadPlugin(client, tenant, pluginId);
  if (
    plugin.record.status !== "published" ||
    plugin.record.publishedVersion === undefined
  ) {
    throw apiError(
      404,
      "plugin_not_installed",
      "this plugin is not installed for your organization",
    );
  }
  const snapshot = await loadSnapshot(
    client,
    tenant,
    pluginId,
    plugin.record.publishedVersion,
  );
  if (!snapshot || snapshot.pluginId !== pluginId) {
    throw apiError(
      404,
      "plugin_not_installed",
      "this plugin is not installed for your organization",
    );
  }
  const memberRoles = await memberRolesFor(
    client,
    config,
    tenant,
    principal,
    req,
    snapshot.product,
  );
  const roles = effectiveRoles(memberRoles, install.roles, snapshot.roles);
  if (!roles.length)
    throw apiError(
      404,
      "plugin_not_installed",
      "this plugin is not installed for your organization",
    );
  if (
    snapshot.audience === "admin" &&
    !intersectRoles(memberRoles, ADMIN_TIER_ROLES).length
  ) {
    throw apiError(
      404,
      "plugin_not_installed",
      "this plugin is not installed for your organization",
    );
  }
  return { snapshot, install, effectiveRoles: roles };
}

/* ------------------------------------------------------------------------- *
 * Catalog
 * ------------------------------------------------------------------------- */

function catalogPayload(
  limits: WorkspaceLimits,
  orgReadiness: WorkspaceOrgReadinessView,
) {
  const workflowExecution = getWorkflowArtifactExecutionReadiness();
  return {
    products: (
      Object.keys(PRODUCT_ROLES) as Array<keyof typeof PRODUCT_ROLES>
    ).map((product) => ({
      product,
      roles: [...PRODUCT_ROLES[product]],
      publicRoles: [...PUBLIC_ROLES],
      resources: PRODUCT_RESOURCES[product].map((resource) => ({
        key: resource.key,
        path: resource.path,
        dataset: resource.dataset,
        ...(commonSource(resource.key)
          ? {
              binding: "capability",
              actions: Object.keys(commonSource(resource.key)!.operations),
            }
          : {}),
      })),
      widgetTypes:
        product === "dx"
          ? WIDGET_TYPES.filter(
              (type) =>
                ![
                  "metric",
                  "table",
                  "form",
                  "chart",
                  "list",
                  "map",
                  "kanban",
                  "timeline",
                ].includes(type),
            )
          : WIDGET_TYPES,
      actionTypes: [...WIDGET_ACTIONS],
    })),
    widgetTypes: [...WIDGET_TYPES],
    actionTypes: [...WIDGET_ACTIONS],
    audiences: ["admin", "member"],
    roles: [...MEMBER_ROLES],
    fieldTypes: [
      "text",
      "number",
      "textarea",
      "select",
      "date",
      "datetime-local",
      "checkbox",
      "email",
      "json",
      "markdown",
      "file",
    ],
    mutation: {
      formExecution: workflowExecution.ready,
      formRequiresWorkflowArtifact: true,
      directDatasetWrites: false,
      reason: workflowExecution.ready
        ? "Forms execute a protected organization-owned workflow artifact through Tier-1; DX never writes product datasets."
        : workflowExecution.requirement,
    },
    workflowExecution,
    workflowOrgReadiness: orgReadiness,
    limits: {
      maxWidgets: limits.maxWidgets,
      maxFields: limits.maxFields,
      maxColumns: limits.maxColumns,
      maxTextLength: limits.maxTextLength,
      maxPluginsPerOrg: limits.maxPluginsPerOrg,
      tokenDefaultDays: limits.tokenDefaultDays,
      tokenMaxDays: limits.tokenMaxDays,
      widgetDataMaxRows: limits.widgetDataMaxRows,
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Revisions
 * ------------------------------------------------------------------------- */

async function persistRevision(
  client: SynapseOneClient,
  plugin: WorkspacePluginRecord,
  status: WorkspacePluginRecord["status"],
): Promise<void> {
  try {
    await client.base.createDocument(COLLECTIONS.workspacePluginRevisions, {
      id: revisionDocumentId(plugin.id, plugin.version),
      data: {
        id: revisionDocumentId(plugin.id, plugin.version),
        tenant: plugin.tenant,
        pluginId: plugin.id,
        version: plugin.version,
        status,
        product: plugin.product,
        name: plugin.name,
        slug: plugin.slug,
        audience: plugin.audience,
        roles: plugin.roles,
        widgets: plugin.widgets,
        createdBy: plugin.createdBy,
        createdAt: plugin.updatedAt,
        checksum: checksumOf({
          product: plugin.product,
          name: plugin.name,
          slug: plugin.slug,
          audience: plugin.audience,
          roles: plugin.roles,
          widgets: plugin.widgets,
        }),
      } as unknown as Record<string, unknown>,
    });
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  // Bounded history: keep the newest REVISION_HISTORY_LIMIT revisions.
  try {
    const result = await queryDocuments<{ version: number }>(
      client,
      COLLECTIONS.workspacePluginRevisions,
      {
        where: { tenant: plugin.tenant, pluginId: plugin.id },
        limit: 1000,
      },
    );
    const stale = result.items
      .map((item) => item.data)
      .sort((a, b) => b.version - a.version)
      .slice(REVISION_HISTORY_LIMIT);
    for (const revision of stale) {
      await client.base
        .deleteDocument(
          COLLECTIONS.workspacePluginRevisions,
          revisionDocumentId(plugin.id, revision.version),
        )
        .catch(() => undefined);
    }
  } catch {
    /* history pruning is best-effort */
  }
}

async function assertUniqueSlug(
  client: SynapseOneClient,
  tenant: string,
  product: string,
  slug: string,
  excludeId?: string,
): Promise<void> {
  const result = await queryDocuments<WorkspacePluginRecord>(
    client,
    COLLECTIONS.workspacePlugins,
    {
      where: { tenant, product, slug },
      limit: 10,
    },
  );
  if (result.items.some((item) => item.data.id !== excludeId)) {
    throw apiError(
      409,
      "plugin_slug_exists",
      "a plugin with this slug already exists for the product",
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Routes
 * ------------------------------------------------------------------------- */

export function registerWorkspacePluginRoutes(
  app: Express,
  config: ServiceConfig,
): void {
  const base = "/v1/capabilities/workspaces";

  app.get(
    `${base}/access`,
    handler(async (req, res) => {
      const context = await workspaceContext(req, config);
      const grants = await workspaceAccess(
        context.client,
        context.tenant,
        context.principal,
      );
      const products = Object.keys(grants).filter(
        (product) => grants[product as keyof typeof grants]?.length,
      );
      res.setHeader("cache-control", "no-store");
      res.json({
        products,
        productRoles: grants,
        modules: products.length ? memberModules(context.principal) : [],
        isOrganizationAdmin: context.principal.isDxAdmin === true,
      });
    }),
  );

  // ---- catalog ----
  app.get(
    `${base}/catalog`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const orgReadiness = await orgReadinessFor(config, context.tenant);
      res.setHeader("cache-control", "no-store");
      res.json(catalogPayload(context.limits, orgReadiness));
    }),
  );

  // ---- plugins (management) ----
  app.get(
    `${base}/plugins`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const product = requireWorkspaceProduct(String(req.query.product ?? ""));
      const pagination = parsePagination(req, config.maxPageSize);
      const result = await queryDocuments<WorkspacePluginRecord>(
        context.client,
        COLLECTIONS.workspacePlugins,
        {
          where: { tenant: context.tenant, product },
          orderBy: { field: "updatedAt", direction: "desc" },
          limit: pagination.limit,
          offset: pagination.offset,
        },
      );
      const installs = await listInstalls(context.client, context.tenant);
      setPageHeaders(res, {
        total: result.total,
        limit: pagination.limit,
        offset: pagination.offset,
        nextCursor: result.nextCursor,
      });
      res.setHeader("cache-control", "no-store");
      res.json({
        items: result.items.map((item) => adminPluginView(item.data, installs)),
        total: result.total,
        limit: pagination.limit,
        offset: pagination.offset,
      });
    }),
  );

  app.post(
    `${base}/plugins`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const body = (req.body || {}) as Record<string, unknown>;
      assertBodyKeys(body, [
        "product",
        "name",
        "slug",
        "audience",
        "roles",
        "widgets",
        "source",
      ]);
      const { source: sourceInput, ...definitionBody } = body;
      const definition = parsePluginDefinition(definitionBody, context.limits, {
        allowWorkflowArtifactId: true,
      });
      const source =
        sourceInput === undefined || sourceInput === null
          ? undefined
          : parseSource(sourceInput);
      await ensureWorkspaceCollections(context.client);
      const existing = await queryDocuments<WorkspacePluginRecord>(
        context.client,
        COLLECTIONS.workspacePlugins,
        {
          where: { tenant: context.tenant },
          limit: 1,
        },
      );
      if (existing.total >= context.limits.maxPluginsPerOrg) {
        throw apiError(
          409,
          "plugin_limit_reached",
          `this organization already has ${context.limits.maxPluginsPerOrg} plugins`,
        );
      }
      await assertUniqueSlug(
        context.client,
        context.tenant,
        definition.product,
        definition.slug,
      );
      await assertArtifactBindings(
        context.client,
        context.tenant,
        definition.widgets,
      );
      const now = new Date().toISOString();
      const record: WorkspacePluginRecord = {
        id: randomUUID(),
        tenant: context.tenant,
        ...(context.principal.org ? { org: context.principal.org } : {}),
        product: definition.product,
        name: definition.name,
        slug: definition.slug,
        audience: definition.audience,
        roles: definition.roles,
        widgets: definition.widgets,
        status: "draft",
        version: 1,
        ...(source ? { source } : {}),
        createdBy: context.principal.subject,
        createdAt: now,
        updatedAt: now,
      };
      await context.client.base.createDocument(COLLECTIONS.workspacePlugins, {
        id: record.id,
        data: record as unknown as Record<string, unknown>,
      });
      await persistRevision(context.client, record, "draft");
      invalidateWorkspaceCaches(context.tenant, record.id);
      await recordAudit(context.client, config, {
        actor: context.principal.subject,
        tenant: context.tenant,
        action: "workspace.plugin.create",
        correlationId: correlationIdOf(req),
        details: {
          pluginId: record.id,
          product: record.product,
          slug: record.slug,
        },
      });
      res.setHeader(
        "location",
        `${base}/plugins/${encodeURIComponent(record.id)}`,
      );
      const installs = await listInstalls(context.client, context.tenant);
      res.status(201).json(adminPluginView(record, installs));
    }),
  );

  app.get(
    `${base}/plugins/:id`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const id = pluginDocumentId(req.params.id);
      const plugin = await loadPlugin(context.client, context.tenant, id);
      const installs = await listInstalls(context.client, context.tenant);
      res.setHeader("cache-control", "no-store");
      res.json(adminPluginView(plugin.record, installs));
    }),
  );

  app.put(
    `${base}/plugins/:id`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const id = pluginDocumentId(req.params.id);
      const current = await loadPlugin(context.client, context.tenant, id);
      const body = (req.body || {}) as Record<string, unknown>;
      assertBodyKeys(body, [
        "version",
        "name",
        "slug",
        "audience",
        "roles",
        "widgets",
        "source",
      ]);
      const requested = Number(body.version);
      if (!Number.isInteger(requested) || requested < 1) {
        throw apiError(
          400,
          "invalid_plugin",
          "version is required for an update",
        );
      }
      if (requested !== current.record.version) {
        throw apiError(
          409,
          "version_conflict",
          "plugin was modified by another request",
          {
            currentVersion: current.record.version,
          },
        );
      }
      const merged = {
        product: current.record.product,
        name: body.name ?? current.record.name,
        slug: body.slug ?? current.record.slug,
        audience: body.audience ?? current.record.audience,
        roles: body.roles ?? current.record.roles,
        widgets: body.widgets ?? current.record.widgets,
      };
      const definition = parsePluginDefinition(merged, context.limits, {
        allowWorkflowArtifactId: true,
      });
      if (definition.product !== current.record.product) {
        throw apiError(400, "invalid_plugin", "product cannot be changed");
      }
      const source =
        body.source === undefined
          ? current.record.source
          : body.source === null
            ? undefined
            : parseSource(body.source);
      if (definition.slug !== current.record.slug) {
        await assertUniqueSlug(
          context.client,
          context.tenant,
          definition.product,
          definition.slug,
          id,
        );
      }
      await assertArtifactBindings(
        context.client,
        context.tenant,
        definition.widgets,
      );
      const updated: WorkspacePluginRecord = {
        ...current.record,
        name: definition.name,
        slug: definition.slug,
        audience: definition.audience,
        roles: definition.roles,
        widgets: definition.widgets,
        version: current.record.version + 1,
        ...(source ? { source } : {}),
        updatedAt: new Date().toISOString(),
      };
      if (!source) {
        delete (updated as { source?: unknown }).source;
      }
      try {
        await context.client.base.updateDocument(
          COLLECTIONS.workspacePlugins,
          id,
          {
            data: updated as unknown as Record<string, unknown>,
            ifVersion: current.version,
          },
        );
      } catch (error) {
        if (isConflict(error))
          throw apiError(
            409,
            "version_conflict",
            "plugin was modified by another request",
          );
        throw error;
      }
      await persistRevision(context.client, updated, updated.status);
      invalidateWorkspaceCaches(context.tenant, id);
      await recordAudit(context.client, config, {
        actor: context.principal.subject,
        tenant: context.tenant,
        action: "workspace.plugin.update",
        correlationId: correlationIdOf(req),
        details: {
          pluginId: id,
          version: updated.version,
          status: updated.status,
        },
      });
      const installs = await listInstalls(context.client, context.tenant);
      res.json(adminPluginView(updated, installs));
    }),
  );

  app.post(
    `${base}/plugins/:id/publish`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const id = pluginDocumentId(req.params.id);
      const current = await loadPlugin(context.client, context.tenant, id);
      const body = (req.body || {}) as Record<string, unknown>;
      assertBodyKeys(body, ["version"]);
      if (
        body.version !== undefined &&
        Number(body.version) !== current.record.version
      ) {
        throw apiError(
          409,
          "version_conflict",
          "plugin was modified by another request",
          {
            currentVersion: current.record.version,
          },
        );
      }
      const governance = actionGovernanceErrors(current.record.widgets);
      if (governance.length)
        throw apiError(400, "action_governance", governance.join("; "));
      await assertArtifactBindings(
        context.client,
        context.tenant,
        current.record.widgets,
      );
      const pinnedWidgets = await pinArtifactBindings(
        context.client,
        context.tenant,
        current.record.widgets,
      );
      const version = current.record.version;
      const checksum = checksumOf({
        product: current.record.product,
        name: current.record.name,
        slug: current.record.slug,
        audience: current.record.audience,
        roles: current.record.roles,
        widgets: pinnedWidgets,
      });
      const snapshot: WorkspaceSnapshotRecord = {
        id: snapshotDocumentId(id, version),
        tenant: context.tenant,
        ...(context.principal.org ? { org: context.principal.org } : {}),
        pluginId: id,
        product: current.record.product,
        name: current.record.name,
        slug: current.record.slug,
        audience: current.record.audience,
        roles: current.record.roles,
        widgets: pinnedWidgets,
        version,
        checksum,
        publishedBy: context.principal.subject,
        publishedAt: new Date().toISOString(),
      };
      await ensureWorkspaceCollections(context.client);
      try {
        await context.client.base.createDocument(
          COLLECTIONS.workspacePluginSnapshots,
          {
            id: snapshot.id,
            data: snapshot as unknown as Record<string, unknown>,
          },
        );
      } catch (error) {
        if (!isConflict(error)) throw error;
        const existing = await getDocumentOrNull<WorkspaceSnapshotRecord>(
          context.client,
          COLLECTIONS.workspacePluginSnapshots,
          snapshot.id,
        );
        if (!existing || existing.data.checksum !== checksum) {
          throw apiError(
            409,
            "version_conflict",
            "a different snapshot already exists for this version",
          );
        }
      }
      const published: WorkspacePluginRecord = {
        ...current.record,
        status: "published",
        publishedVersion: version,
        publishedAt: snapshot.publishedAt,
        updatedAt: snapshot.publishedAt,
        checksum,
      };
      delete published.unpublishedAt;
      try {
        await context.client.base.updateDocument(
          COLLECTIONS.workspacePlugins,
          id,
          {
            data: published as unknown as Record<string, unknown>,
            ifVersion: current.version,
          },
        );
      } catch (error) {
        if (isConflict(error))
          throw apiError(
            409,
            "version_conflict",
            "plugin was modified by another request",
          );
        throw error;
      }
      await persistRevision(context.client, published, "published");
      invalidateWorkspaceCaches(context.tenant, id);
      await recordAudit(context.client, config, {
        actor: context.principal.subject,
        tenant: context.tenant,
        action: "workspace.plugin.publish",
        correlationId: correlationIdOf(req),
        details: { pluginId: id, version, checksum },
      });
      const installs = await listInstalls(context.client, context.tenant);
      res.json(adminPluginView(published, installs));
    }),
  );

  app.post(
    `${base}/plugins/:id/unpublish`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const id = pluginDocumentId(req.params.id);
      const current = await loadPlugin(context.client, context.tenant, id);
      const body = (req.body || {}) as Record<string, unknown>;
      assertBodyKeys(body, ["version"]);
      if (
        body.version !== undefined &&
        Number(body.version) !== current.record.version
      ) {
        throw apiError(
          409,
          "version_conflict",
          "plugin was modified by another request",
          {
            currentVersion: current.record.version,
          },
        );
      }
      if (current.record.status === "draft") {
        const installs = await listInstalls(context.client, context.tenant);
        res.json(adminPluginView(current.record, installs));
        return;
      }
      const now = new Date().toISOString();
      const unpublished: WorkspacePluginRecord = {
        ...current.record,
        status: "draft",
        unpublishedAt: now,
        updatedAt: now,
      };
      try {
        await context.client.base.updateDocument(
          COLLECTIONS.workspacePlugins,
          id,
          {
            data: unpublished as unknown as Record<string, unknown>,
            ifVersion: current.version,
          },
        );
      } catch (error) {
        if (isConflict(error))
          throw apiError(
            409,
            "version_conflict",
            "plugin was modified by another request",
          );
        throw error;
      }
      invalidateWorkspaceCaches(context.tenant, id);
      await recordAudit(context.client, config, {
        actor: context.principal.subject,
        tenant: context.tenant,
        action: "workspace.plugin.unpublish",
        correlationId: correlationIdOf(req),
        details: {
          pluginId: id,
          publishedVersion: current.record.publishedVersion ?? null,
        },
      });
      const installs = await listInstalls(context.client, context.tenant);
      res.json(adminPluginView(unpublished, installs));
    }),
  );

  app.get(
    `${base}/plugins/:id/revisions`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const id = pluginDocumentId(req.params.id);
      await loadPlugin(context.client, context.tenant, id);
      const pagination = parsePagination(req, config.maxPageSize);
      const result = await queryDocuments<Record<string, unknown>>(
        context.client,
        COLLECTIONS.workspacePluginRevisions,
        {
          where: { tenant: context.tenant, pluginId: id },
          orderBy: { field: "version", direction: "desc" },
          limit: pagination.limit,
          offset: pagination.offset,
        },
      );
      setPageHeaders(res, {
        total: result.total,
        limit: pagination.limit,
        offset: pagination.offset,
        nextCursor: result.nextCursor,
      });
      res.setHeader("cache-control", "no-store");
      res.json({
        items: result.items.map((item) => ({
          version: item.data.version,
          status: item.data.status,
          createdAt: item.data.createdAt,
          createdBy: item.data.createdBy,
          checksum: item.data.checksum,
        })),
        total: result.total,
        limit: pagination.limit,
        offset: pagination.offset,
      });
    }),
  );

  // ---- build / export / import ----
  /**
   * Build a Tier-3 repository artifact from the immutable published snapshot.
   *
   * This is deliberately separate from export: export can serialize the
   * current draft for authoring/backup, while a build must be reviewable,
   * reproducible and tied to the owning repository. The returned body is the
   * exact portable bundle the Tier-3 CLI validates and commits; target
   * metadata is exposed in headers so the JSON shape stays checksum-stable.
   */
  app.get(
    `${base}/plugins/:id/build`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const id = pluginDocumentId(req.params.id);
      const plugin = await loadPlugin(context.client, context.tenant, id);
      if (
        plugin.record.status !== "published" ||
        plugin.record.publishedVersion === undefined
      ) {
        throw apiError(
          409,
          "plugin_not_published",
          "publish the plugin before building a Tier-3 repository artifact",
        );
      }
      const snapshot = await loadSnapshot(
        context.client,
        context.tenant,
        plugin.record.id,
        plugin.record.publishedVersion,
      );
      if (!snapshot) {
        throw apiError(
          409,
          "plugin_snapshot_missing",
          "the published snapshot is missing; republish the plugin",
        );
      }
      const source = plugin.record.source
        ? requireBuildSource(plugin.record.product, plugin.record.source)
        : canonicalPluginSource(plugin.record.product, snapshot.slug);
      const unpinned = snapshot.widgets.find(
        (widget) =>
          widget.type === "form" &&
          widget.workflowArtifactId !== undefined &&
          (widget.workflowArtifactRevision === undefined ||
            widget.workflowArtifactChecksum === undefined),
      );
      if (unpinned) {
        throw apiError(
          409,
          "artifact_out_of_sync",
          "the published form has no reviewed artifact pin; republish the plugin before building",
          { widgetId: unpinned.id },
        );
      }
      const record = publishedBuildRecord(plugin.record, snapshot, source);
      const refs = await artifactRefsFor(
        context.client,
        context.tenant,
        record.widgets,
      );
      const bundle = buildBundle(record, refs, source);
      const filename =
        source.path.split("/").pop() || `${plugin.record.slug}.plugin.json`;
      await recordAudit(context.client, config, {
        actor: context.principal.subject,
        tenant: context.tenant,
        action: "workspace.plugin.build",
        correlationId: correlationIdOf(req),
        details: {
          pluginId: id,
          publishedVersion: snapshot.version,
          checksum: bundle.checksum,
          repository: source.repository,
          path: source.path,
        },
      });
      res.setHeader("x-synapsedx-build-plugin", id);
      res.setHeader("x-synapsedx-build-version", String(snapshot.version));
      res.setHeader("x-synapsedx-build-checksum", bundle.checksum || "");
      res.setHeader("x-synapsedx-build-repository", source.repository);
      res.setHeader("x-synapsedx-build-path", source.path);
      res.setHeader("x-synapsedx-build-file", filename);
      if (String(req.query.download || "") === "1") {
        res.setHeader(
          "content-disposition",
          `attachment; filename="${filename}"`,
        );
      }
      res.setHeader("cache-control", "no-store");
      res.json(bundle);
    }),
  );

  app.get(
    `${base}/plugins/:id/export`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const id = pluginDocumentId(req.params.id);
      const plugin = await loadPlugin(context.client, context.tenant, id);
      const wantsDraft = String(req.query.draft || "") === "1";
      let snapshot: WorkspaceSnapshotRecord | null = null;
      if (!wantsDraft) {
        // The default export path is consumed by the Tier-3 sync CLI. It must
        // never silently write an unreviewed draft into a repository.
        if (
          plugin.record.status !== "published" ||
          plugin.record.publishedVersion === undefined
        ) {
          throw apiError(
            409,
            "plugin_not_published",
            "publish the plugin before exporting a repository snapshot; use ?draft=1 for authoring",
          );
        }
        snapshot = await loadSnapshot(
          context.client,
          context.tenant,
          plugin.record.id,
          plugin.record.publishedVersion,
        );
        if (!snapshot) {
          throw apiError(
            409,
            "plugin_snapshot_missing",
            "the published snapshot is missing; republish the plugin",
          );
        }
      }
      const source = snapshot
        ? plugin.record.source
          ? requireBuildSource(plugin.record.product, plugin.record.source)
          : canonicalPluginSource(plugin.record.product, snapshot.slug)
        : plugin.record.source;
      const record = snapshot
        ? publishedBuildRecord(plugin.record, snapshot, source)
        : plugin.record;
      const refs = await artifactRefsFor(
        context.client,
        context.tenant,
        record.widgets,
      );
      const bundle = buildBundle(record, refs);
      await recordAudit(context.client, config, {
        actor: context.principal.subject,
        tenant: context.tenant,
        action: "workspace.plugin.export",
        correlationId: correlationIdOf(req),
        details: {
          pluginId: id,
          version: record.version,
          published: Boolean(snapshot),
          checksum: bundle.checksum,
        },
      });
      if (String(req.query.download || "") === "1") {
        const filename = `${plugin.record.slug.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "plugin"}.synapsedx-plugin.json`;
        res.setHeader(
          "content-disposition",
          `attachment; filename="${filename}"`,
        );
      }
      res.setHeader("cache-control", "no-store");
      res.json(bundle);
    }),
  );

  app.post(
    `${base}/import`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const bundle = parseBundle(req.body || {}, context.limits);
      const definition = bundle.plugin;
      const widgets = await resolveArtifactRefs(
        context.client,
        context.tenant,
        definition.widgets,
      );
      await ensureWorkspaceCollections(context.client);
      const existing = await queryDocuments<WorkspacePluginRecord>(
        context.client,
        COLLECTIONS.workspacePlugins,
        {
          where: { tenant: context.tenant },
          limit: 1,
        },
      );
      if (existing.total >= context.limits.maxPluginsPerOrg) {
        throw apiError(
          409,
          "plugin_limit_reached",
          `this organization already has ${context.limits.maxPluginsPerOrg} plugins`,
        );
      }
      await assertUniqueSlug(
        context.client,
        context.tenant,
        definition.product,
        definition.slug,
      );
      await assertArtifactBindings(context.client, context.tenant, widgets);
      const now = new Date().toISOString();
      const record: WorkspacePluginRecord = {
        id: randomUUID(),
        tenant: context.tenant,
        ...(context.principal.org ? { org: context.principal.org } : {}),
        product: definition.product,
        name: definition.name,
        slug: definition.slug,
        audience: definition.audience,
        roles: definition.roles,
        widgets,
        status: "draft",
        version: 1,
        ...(bundle.source ? { source: bundle.source } : {}),
        ...(bundle.checksum ? { checksum: bundle.checksum } : {}),
        createdBy: context.principal.subject,
        createdAt: now,
        updatedAt: now,
      };
      await context.client.base.createDocument(COLLECTIONS.workspacePlugins, {
        id: record.id,
        data: record as unknown as Record<string, unknown>,
      });
      await persistRevision(context.client, record, "draft");
      invalidateWorkspaceCaches(context.tenant, record.id);
      await recordAudit(context.client, config, {
        actor: context.principal.subject,
        tenant: context.tenant,
        action: "workspace.plugin.import",
        correlationId: correlationIdOf(req),
        details: {
          pluginId: record.id,
          product: record.product,
          checksum: bundle.checksum ?? null,
        },
      });
      const installs = await listInstalls(context.client, context.tenant);
      res.setHeader(
        "location",
        `${base}/plugins/${encodeURIComponent(record.id)}`,
      );
      res.status(201).json(adminPluginView(record, installs));
    }),
  );

  // ---- installation ----
  app.post(
    `${base}/plugins/:id/install`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const id = pluginDocumentId(req.params.id);
      const plugin = await loadPlugin(context.client, context.tenant, id);
      if (
        plugin.record.status !== "published" ||
        plugin.record.publishedVersion === undefined
      ) {
        throw apiError(
          409,
          "plugin_not_published",
          "publish the plugin before installing it",
        );
      }
      const snapshot = await loadSnapshot(
        context.client,
        context.tenant,
        id,
        plugin.record.publishedVersion,
      );
      if (!snapshot)
        throw apiError(
          409,
          "plugin_not_published",
          "the published snapshot is missing; publish again",
        );
      const body = (req.body || {}) as Record<string, unknown>;
      assertBodyKeys(body, ["roles"]);
      let roles: string[] = [];
      if (body.roles !== undefined) {
        if (!Array.isArray(body.roles))
          throw apiError(400, "invalid_role", "roles must be an array");
        if (body.roles.length === 0) {
          roles = [];
        } else {
          const requested = normalizeRoles(
            body.roles,
            plugin.record.product,
            context.limits,
          );
          const allowed = new Set(
            plugin.record.roles.map((role) => role.toLowerCase()),
          );
          const widened = requested.filter((role) => !allowed.has(role));
          if (widened.length) {
            throw apiError(
              400,
              "invalid_role",
              "installation roles must narrow the published plugin roles",
              {
                notAllowed: widened,
              },
            );
          }
          roles = requested;
        }
      }
      await ensureWorkspaceCollections(context.client);
      const existing = await loadInstall(context.client, context.tenant, id);
      const now = new Date().toISOString();
      if (existing) {
        const updated: WorkspaceInstallRecord = {
          ...existing,
          roles,
          installedBy: context.principal.subject,
          updatedAt: now,
        };
        const document = await getDocumentOrNull<WorkspaceInstallRecord>(
          context.client,
          COLLECTIONS.workspaceInstalls,
          existing.id,
        );
        try {
          await context.client.base.updateDocument(
            COLLECTIONS.workspaceInstalls,
            existing.id,
            {
              data: updated as unknown as Record<string, unknown>,
              ...(document ? { ifVersion: document.version } : {}),
            },
          );
        } catch (error) {
          if (isConflict(error))
            throw apiError(
              409,
              "version_conflict",
              "the installation was modified by another request",
            );
          throw error;
        }
        installCache.delete(`${context.tenant}:${id}`);
        installListCache.delete(context.tenant);
        await recordAudit(context.client, config, {
          actor: context.principal.subject,
          tenant: context.tenant,
          action: "workspace.plugin.install",
          correlationId: correlationIdOf(req),
          details: { pluginId: id, roles, updated: true },
        });
        res.json(updated);
        return;
      }
      const record: WorkspaceInstallRecord = {
        id: installDocumentId(context.tenant, id),
        tenant: context.tenant,
        ...(context.principal.org ? { org: context.principal.org } : {}),
        pluginId: id,
        product: plugin.record.product,
        roles,
        installedBy: context.principal.subject,
        installedAt: now,
        updatedAt: now,
      };
      try {
        await context.client.base.createDocument(
          COLLECTIONS.workspaceInstalls,
          {
            id: record.id,
            data: record as unknown as Record<string, unknown>,
          },
        );
      } catch (error) {
        if (isConflict(error))
          throw apiError(
            409,
            "installation_exists",
            "this plugin is already installed",
          );
        throw error;
      }
      installCache.delete(`${context.tenant}:${id}`);
      installListCache.delete(context.tenant);
      await recordAudit(context.client, config, {
        actor: context.principal.subject,
        tenant: context.tenant,
        action: "workspace.plugin.install",
        correlationId: correlationIdOf(req),
        details: { pluginId: id, roles },
      });
      res.status(201).json(record);
    }),
  );

  app.delete(
    `${base}/plugins/:id/install`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const id = pluginDocumentId(req.params.id);
      const existing = await loadInstall(context.client, context.tenant, id);
      if (!existing)
        throw apiError(
          404,
          "plugin_not_installed",
          "this plugin is not installed for your organization",
        );
      try {
        await context.client.base.deleteDocument(
          COLLECTIONS.workspaceInstalls,
          existing.id,
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      installCache.delete(`${context.tenant}:${id}`);
      installListCache.delete(context.tenant);
      await recordAudit(context.client, config, {
        actor: context.principal.subject,
        tenant: context.tenant,
        action: "workspace.plugin.uninstall",
        correlationId: correlationIdOf(req),
        details: { pluginId: id },
      });
      res.status(204).end();
    }),
  );

  /**
   * Dataset readiness check — deliberately **verify-only**.
   *
   * A fixed product dataset is shared by every organization and an absent
   * `tenant` is not proof of ownership; letting an organization admin stamp it
   * would hijack global product data. This endpoint therefore never writes and
   * never adopts: it reports whether each dataset used by the plugin is already
   * owned by this organization. Creating/migrating a dataset to an organization
   * is an explicit operator/deployment action (tenant/account inventory) outside
   * this API.
   */
  app.post(
    `${base}/plugins/:id/provision`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const id = pluginDocumentId(req.params.id);
      const plugin = await loadPlugin(context.client, context.tenant, id);
      const resources = new Map<
        string,
        { resource: string; dataset: string }
      >();
      for (const widget of plugin.record.widgets) {
        if (!widget.resource) continue;
        const mapping = resourceFor(plugin.record.product, widget.resource);
        if (mapping)
          resources.set(mapping.key, {
            resource: mapping.key,
            dataset: mapping.dataset,
          });
      }
      const items: Array<{
        resource: string;
        dataset: string;
        status: string;
      }> = [];
      for (const entry of resources.values()) {
        if (entry.dataset.startsWith("common:")) {
          items.push({ ...entry, status: "ready" });
          continue;
        }
        const found = await loadWorkspaceDataset(context.client, entry.dataset);
        if (!found) {
          items.push({ ...entry, status: "missing" });
          continue;
        }
        if (!found.data.tenant) {
          items.push({ ...entry, status: "unowned" });
          continue;
        }
        if (found.data.tenant !== context.tenant) {
          items.push({ ...entry, status: "other_tenant" });
          continue;
        }
        items.push({ ...entry, status: "ready" });
      }
      const ready =
        items.length > 0 && items.every((item) => item.status === "ready");
      const payload = {
        pluginId: id,
        ready,
        bound: items.filter((item) => item.status === "ready").length,
        items,
      };
      await recordAudit(context.client, config, {
        actor: context.principal.subject,
        tenant: context.tenant,
        action: "workspace.dataset.verify",
        correlationId: correlationIdOf(req),
        details: { pluginId: id, ready, items },
      });
      if (!ready) {
        res.status(409);
        res.json({
          error: {
            code: "dataset_provisioning_failed",
            message:
              "every dataset used by this plugin must already be owned by this organization; DX does not adopt global or unowned datasets",
            requestId: correlationIdOf(req),
            details: payload,
          },
        });
        return;
      }
      res.json(payload);
    }),
  );

  // ---- member workspace ----
  app.get(
    `${base}/installed`,
    handler(async (req, res) => {
      const context = await workspaceContext(req, config);
      const entries = await installedEntries(
        context.client,
        config,
        context.tenant,
        context.principal,
        req,
      );
      const artifacts = await loadArtifactMap(
        context.client,
        context.tenant,
        entries,
      );
      const orgReadiness = await readinessForEntries(
        config,
        context.tenant,
        entries,
      );
      res.setHeader("cache-control", "no-store");
      res.json({
        items: entries.map((entry) =>
          installedView(entry, artifacts, orgReadiness),
        ),
        total: entries.length,
      });
    }),
  );

  app.get(
    `${base}/installed/:id`,
    handler(async (req, res) => {
      const context = await workspaceContext(req, config);
      const id = pluginDocumentId(req.params.id);
      const entry = await installedEntry(
        context.client,
        config,
        context.tenant,
        context.principal,
        req,
        id,
      );
      const artifacts = await loadArtifactMap(context.client, context.tenant, [
        entry,
      ]);
      const orgReadiness = await readinessForEntries(config, context.tenant, [
        entry,
      ]);
      res.setHeader("cache-control", "no-store");
      res.json(installedView(entry, artifacts, orgReadiness));
    }),
  );

  app.get(
    `${base}/installed/:id/widgets/:widgetId/options/:field`,
    handler(async (req, res) => {
      const context = await workspaceContext(req, config),
        entry = await installedEntry(
          context.client,
          config,
          context.tenant,
          context.principal,
          req,
          pluginDocumentId(req.params.id),
        );
      const field = entry.snapshot.widgets
        .find(
          (widget) =>
            widget.id === req.params.widgetId && widget.type === "form",
        )
        ?.fields?.find((field) => field.name === req.params.field);
      const referenceQuery = requireRegisteredAction(
        entry.snapshot.widgets,
        req.query.action,
        String(req.params.widgetId),
        "query",
      );
      if (
        referenceQuery.kind !== "query" ||
        referenceQuery.source !== field?.optionsResource ||
        req.query.action !== field?.optionsAction
      )
        throw apiError(
          403,
          "query_source_invalid",
          "Reference options require their published query",
        );
      if (!field?.optionsResource || !commonSource(field.optionsResource))
        throw apiError(404, "not_found", "reference source not configured");
      queryInput(req, referenceQuery);
      // Legacy reference presets have no pagination mappings and retain their
      // bounded collection view. Explicit pagination is honored when declared.
      const pagination = parsePagination(req, 5000);
      const limit = req.query.limit === undefined ? 5000 : pagination.limit;
      const sortBy = String(req.query.sortBy || "");
      if (sortBy && !["id", "name", "title", "filename", "status"].includes(sortBy))
        throw apiError(400, "query_input_invalid", "Unsupported reference sort field");
      const direction = req.query.sortDirection || "asc";
      if (!["asc", "desc"].includes(String(direction)))
        throw apiError(400, "query_input_invalid", "Sort direction must be asc or desc");
      let rows = await commonRows(
        config,
        context.caller.credential,
        entry.snapshot.product,
        field.optionsResource,
      );
      const search = String(req.query.search || "").toLowerCase();
      if (search) rows = rows.filter((row: any) =>
        [row.id, row.name, row.title, row.filename].some(value => String(value ?? "").toLowerCase().includes(search)));
      if (req.query.status) rows = rows.filter((row: any) => String(row.status || "") === req.query.status);
      if (sortBy) rows.sort((a: any, b: any) => String(a[sortBy] ?? "").localeCompare(String(b[sortBy] ?? ""), undefined, { numeric: true }) * (direction === "desc" ? -1 : 1));
      const total = rows.length;
      res.setHeader("cache-control", "no-store");
      res.json({
        total, limit, offset: pagination.offset,
        items: rows.slice(pagination.offset, pagination.offset + limit).map((row: any) => ({
          value: String(row.id),
          label: String(row.name ?? row.title ?? row.filename ?? row.id),
        })),
      });
    }),
  );

  app.get(
    `${base}/installed/:id/widgets/:widgetId/records/:recordId`,
    handler(async (req, res) => {
      const context = await workspaceContext(req, config);
      const entry = await installedEntry(
        context.client,
        config,
        context.tenant,
        context.principal,
        req,
        pluginDocumentId(req.params.id),
      );
      const widget = entry.snapshot.widgets.find(
        (widget) =>
          widget.id === req.params.widgetId &&
          ["table", "list", "map", "kanban", "timeline"].includes(widget.type),
      );
      const detailAction = entry.snapshot.widgets.find(
        (w) => w.type === "action" && w.id === req.query.action,
      )?.operation;
      if (
        !widget ||
        detailAction?.kind !== "showRecord" ||
        detailAction.target !== widget.id ||
        req.query.action !== widget.onRowClick
      )
        throw apiError(
          403,
          "action_not_registered",
          "Record details require the published row action",
        );
      if (widget && commonSource(widget.resource)) {
        const data = await commonDetail(
          config,
          context.caller.credential,
          entry.snapshot.product,
          widget.resource!,
          String(req.params.recordId),
        );
        res.json({ id: data.id, data, version: 0 });
        return;
      }
      const mapping = widget?.resource
        ? resourceFor(entry.snapshot.product, widget.resource)
        : undefined;
      if (!mapping) throw apiError(404, "not_found", "record not found");
      const dataset = await loadWorkspaceDataset(
        context.client,
        mapping.dataset,
      );
      if (!dataset || dataset.data.tenant !== context.tenant)
        throw apiError(404, "not_found", "record not found");
      const id = String(req.params.recordId || "");
      if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id))
        throw apiError(404, "not_found", "record not found");
      const record = await getDocumentOrNull<CapabilityRecord>(
        context.client,
        COLLECTIONS.records,
        id,
      );
      if (
        !record ||
        record.data.datasetId !== mapping.dataset ||
        record.data.deletedAt
      )
        throw apiError(404, "not_found", "record not found");
      res.setHeader("cache-control", "no-store");
      res.json({
        id: record.data.id,
        data: record.data.data,
        version: record.version,
        createdAt: record.data.createdAt,
        updatedAt: record.data.updatedAt,
      });
    }),
  );

  app.get(
    `${base}/installed/:id/widgets/:widgetId/data`,
    handler(async (req, res) => {
      const context = await workspaceContext(req, config);
      const id = pluginDocumentId(req.params.id);
      const entry = await installedEntry(
        context.client,
        config,
        context.tenant,
        context.principal,
        req,
        id,
      );
      const widgetId = String(req.params.widgetId || "").trim();
      const widget = entry.snapshot.widgets.find(
        (candidate) => candidate.id === widgetId,
      );
      if (!widget) throw apiError(404, "widget_not_found", "widget not found");
      const registered = requireRegisteredAction(
        entry.snapshot.widgets,
        req.query.action,
        widget.id,
        "query",
      );
      queryInput(req, registered);
      if (registered.kind === "query") {
        if (registered.source !== widget.resource)
          throw apiError(
            403,
            "query_source_invalid",
            "Query source does not match its published catalog binding",
          );
      }

      if (widget.type === "form") {
        throw apiError(
          400,
          "mutation_not_supported",
          "form widgets are executed through the workflow action endpoint, not read as data",
        );
      }
      if (
        ![
          "metric",
          "table",
          "chart",
          "list",
          "map",
          "kanban",
          "timeline",
        ].includes(widget.type)
      ) {
        throw apiError(
          400,
          "widget_data_unavailable",
          "this widget type has no data source",
        );
      }
      if (!widget.resource)
        throw apiError(
          400,
          "widget_data_unavailable",
          "this widget has no bound resource",
        );
      const allowedQuery = new Set([
        "action",
        "limit",
        "offset",
        "search",
        "status",
        "sortBy",
        "sortDirection",
      ]);
      if (Object.keys(req.query).some((key) => !allowedQuery.has(key)))
        throw apiError(
          400,
          "query_input_invalid",
          "Undeclared query parameter",
        );
      for (const key of ["search", "status", "sortBy", "sortDirection"])
        if (
          req.query[key] !== undefined &&
          (typeof req.query[key] !== "string" ||
            (req.query[key] as string).length > 200)
        )
          throw apiError(400, "query_input_invalid", "Invalid query value");
      const sortBy =
        typeof req.query.sortBy === "string" ? req.query.sortBy : undefined;
      if (sortBy && sortBy !== "id" && !widget.columns?.includes(sortBy))
        throw apiError(
          400,
          "query_input_invalid",
          "Sort field must be a published column",
        );
      const sortDirection = req.query.sortDirection || "asc";
      if (!["asc", "desc"].includes(String(sortDirection)))
        throw apiError(
          400,
          "query_input_invalid",
          "Sort direction must be asc or desc",
        );
      if (String(req.query.search || "").trim() && !widget.columns?.length)
        throw apiError(400, "query_input_invalid", "Search requires published columns; use a table query for text filters");
      if (commonSource(widget.resource)) {
        const pagination = parsePagination(
            req,
            context.limits.widgetDataMaxRows,
          ),
          columns = widget.columns || [];
        let rows = await commonRows(
          config,
          context.caller.credential,
          entry.snapshot.product,
          widget.resource,
        );
        const search = String(req.query.search || "").toLowerCase();
        if (search)
          rows = rows.filter((row: any) =>
            columns.some((key) =>
              String(row[key] ?? "")
                .toLowerCase()
                .includes(search),
            ),
          );
        if (req.query.status)
          rows = rows.filter(
            (row: any) => String(row.status || "") === req.query.status,
          );
        if (sortBy)
          rows.sort(
            (a: any, b: any) =>
              String(a[sortBy] ?? "").localeCompare(
                String(b[sortBy] ?? ""),
                undefined,
                { numeric: true },
              ) * (sortDirection === "desc" ? -1 : 1),
          );
        const total = rows.length;
        if (widget.type === "metric") {
          res.json({ type: "metric", widgetId: widget.id, count: total });
          return;
        }
        res.setHeader("cache-control", "no-store");
        res.json({
          type: widget.type,
          widgetId: widget.id,
          columns,
          items: rows
            .slice(pagination.offset, pagination.offset + pagination.limit)
            .map((row: any) =>
              Object.fromEntries(
                ["id", ...columns].map((key) => [key, row[key] ?? null]),
              ),
            ),
          total,
          limit: pagination.limit,
          offset: pagination.offset,
        });
        return;
      }
      const mapping = resourceFor(entry.snapshot.product, widget.resource);
      if (!mapping)
        throw apiError(
          409,
          "resource_not_allowed",
          "this widget resource is no longer allowed",
        );
      const dataset = await loadWorkspaceDataset(
        context.client,
        mapping.dataset,
      );
      if (!dataset || dataset.data.tenant !== context.tenant) {
        throw apiError(
          404,
          "widget_data_unavailable",
          "the bound dataset is not provisioned for this organization",
        );
      }
      const prefix = entry.snapshot.product === "city" ? "city-" : "sos-";
      if (!dataset.data.id.startsWith(prefix)) {
        throw apiError(
          409,
          "resource_not_allowed",
          "the bound dataset does not belong to this product",
        );
      }
      const pagination = parsePagination(req, context.limits.widgetDataMaxRows);
      const clauses: any[] = [
        { datasetId: mapping.dataset },
        { deletedAt: { exists: false } },
      ];
      const search = String(req.query.search || "")
        .trim()
        .slice(0, 120);
      const status = String(req.query.status || "")
        .trim()
        .slice(0, 80);
      const columns = (widget.columns || []).slice(
        0,
        context.limits.maxColumns,
      );
      if (search && columns.length)
        clauses.push({
          or: columns
            .map((column) => ({
              field: column === "id" ? "id" : `data.${column}`,
              op: "contains",
              value: search,
            })),
        });
      if (status)
        clauses.push({ field: "data.status", op: "eq", value: status });
      const result = await queryDocuments<CapabilityRecord>(
        context.client,
        COLLECTIONS.records,
        {
          where: { and: clauses },
          orderBy: {
            field: !sortBy || sortBy === "id" ? "id" : `data.${sortBy}`,
            direction: sortDirection as "asc" | "desc",
          },
          limit: widget.type === "metric" ? 1 : pagination.limit,
          offset: widget.type === "metric" ? 0 : pagination.offset,
        },
      );
      res.setHeader("cache-control", "no-store");
      if (widget.type === "metric") {
        res.json({
          widgetId: widget.id,
          type: "metric",
          title: widget.title,
          resource: widget.resource,
          count: result.total,
          generatedAt: new Date().toISOString(),
        });
        return;
      }
      res.json({
        widgetId: widget.id,
        type: widget.type,
        title: widget.title,
        resource: widget.resource,
        columns,
        items: result.items.map((item) => {
          const row: Record<string, unknown> = { id: item.data.id };
          for (const column of columns) {
            row[column] =
              column === "id"
                ? item.data.id
                : (item.data.data?.[column] ?? null);
          }
          return row;
        }),
        total: result.total,
        limit: pagination.limit,
        offset: pagination.offset,
        generatedAt: new Date().toISOString(),
      });
    }),
  );

  /**
   * Execute a bound form.
   *
   * Only declared fields are accepted; the payload is forwarded as data to the
   * organization-owned Tier-1 workflow with the caller's own verified
   * credential. DX never writes a product dataset and never runs plugin code.
   */
  app.get(`${base}/installed/:id/widgets/:widgetId/executions/:executionId`, handler(async (req, res) => {
    const context = await workspaceContext(req, config);
    const id = pluginDocumentId(req.params.id);
    const entry = await installedEntry(context.client, config, context.tenant, context.principal, req, id);
    const widget = entry.snapshot.widgets.find(w => w.id === req.params.widgetId && w.type === "form");
    if (!widget?.workflowArtifactId) throw apiError(404, "widget_not_found", "Workflow form not found");
    requireRegisteredAction(entry.snapshot.widgets, req.query.action, widget.id, "mutation");
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await readPluginExecution(config, context.caller, widget.workflowArtifactId, String(req.params.executionId), id, widget.id));
  }));

  app.post(`${base}/installed/:id/widgets/:widgetId/upload`, express.raw({ type: () => true, limit: Math.min(config.filesMaxBytes, 20971520) }), handler(async (req, res) => {
    const context = await workspaceContext(req, config);
    const entry = await installedEntry(context.client, config, context.tenant, context.principal, req, pluginDocumentId(req.params.id));
    const widget = entry.snapshot.widgets.find(w => w.id === req.params.widgetId);
    if (!widget || widget.type !== "form") throw apiError(404, "widget_not_found", "File form not found");
    const op = requireRegisteredAction(entry.snapshot.widgets, req.query.action, widget.id, "upload");
    const field = widget.fields?.find(f => f.name === op.source && f.type === "file" && f.uploadAction === req.query.action);
    if (!field) throw apiError(403, "action_not_registered", "Choose the published upload action for this field");
    if (Object.keys(req.query).some(key => key !== "action")) throw apiError(400, "invalid_request", "Undeclared upload parameter");
    if (!entry.effectiveRoles.some(role => role !== "viewer")) throw apiError(403, "forbidden", "This membership cannot upload files");
    const contentType = String(req.header("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw apiError(400, "field_required", "Choose a nonempty file");
    const maxBytes = Math.min(config.filesMaxBytes, field.maxBytes || 10485760);
    if (bytes.length > maxBytes) throw apiError(413, "file_too_large", "File exceeds the published field limit", { maxBytes });
    if (!fileTypeAccepted(field.accept, contentType)) throw apiError(415, "file_type_not_allowed", "File type is not accepted by this field");
    let filename: string;
    try { filename = decodeURIComponent(req.header("x-file-name") || ""); }
    catch { throw apiError(400, "invalid_request", "Invalid file name encoding"); }
    const file = await callCommon(config, context.caller.credential, entry.snapshot.product, "files", "POST", { filename, contentType, size: bytes.length });
    try {
      const uploaded = await callCommonBytes(config, context.caller.credential, entry.snapshot.product, `files/${encodeURIComponent(file.id)}/content`, "PUT", bytes, contentType);
      const result = JSON.parse(uploaded.bytes.toString("utf8"));
      await recordAudit(context.client, config, { actor: context.principal.subject, tenant: context.tenant, action: "workspace.file.upload", correlationId: correlationIdOf(req), details: { pluginId: entry.snapshot.pluginId, widgetId: widget.id, actionId: req.query.action, field: field.name, product: entry.snapshot.product, fileId: file.id } });
      res.status(201).json(result);
    } catch (error) {
      await callCommon(config, context.caller.credential, entry.snapshot.product, `files/${encodeURIComponent(file.id)}`, "DELETE").catch(() => {});
      throw error;
    }
  }));

  app.post(`${base}/installed/:id/widgets/:widgetId/download`, handler(async (req, res) => {
    const context = await workspaceContext(req, config);
    const entry = await installedEntry(context.client, config, context.tenant, context.principal, req, pluginDocumentId(req.params.id));
    const widget = entry.snapshot.widgets.find(w => w.id === req.params.widgetId);
    if (!widget) throw apiError(404, "widget_not_found", "File source not found");
    const op = requireRegisteredAction(entry.snapshot.widgets, req.query.action, widget.id, "download");
    const error = actionPayloadError(op, req.body?.values);
    if (error) throw apiError(400, "action_input_invalid", error);
    const id = req.body?.values?.file_id;
    if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw apiError(400, "invalid_request", "Choose a valid file ID");
    const result = await callCommonBytes(config, context.caller.credential, entry.snapshot.product, `files/${encodeURIComponent(id)}/content`);
    res.setHeader("Content-Type", result.contentType);
    if (result.disposition) res.setHeader("Content-Disposition", result.disposition);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(result.bytes);
  }));

  app.post(
    `${base}/installed/:id/widgets/:widgetId/execute`,
    handler(async (req, res) => {
      const context = await workspaceContext(req, config);
      const id = pluginDocumentId(req.params.id);
      const entry = await installedEntry(
        context.client,
        config,
        context.tenant,
        context.principal,
        req,
        id,
      );
      const widgetId = String(req.params.widgetId || "").trim();
      const widget = entry.snapshot.widgets.find(
        (candidate) => candidate.id === widgetId,
      );
      if (!widget) throw apiError(404, "widget_not_found", "widget not found");
      const registered = requireRegisteredAction(
        entry.snapshot.widgets,
        req.query.action,
        widget.id,
        "mutation",
      );
      const payloadError = actionPayloadError(registered, req.body?.values);
      if (payloadError)
        throw apiError(400, "action_input_invalid", payloadError);
      if (widget.type !== "form") {
        throw apiError(
          400,
          "mutation_not_supported",
          "only form widgets can execute an action",
        );
      }
      for (const field of widget.fields || []) {
        if (field.type !== "file" || !req.body?.values?.[field.name]) continue;
        const id = req.body.values[field.name];
        if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw apiError(400, "invalid_request", "Invalid file reference");
        const file = await callCommon(config, context.caller.credential, entry.snapshot.product, `files/${encodeURIComponent(id)}`);
        if (!file.checksumSha256) throw apiError(409, "upload_incomplete", "Finish uploading the file before submitting");
        if (file.size > (field.maxBytes || 10485760) || !fileTypeAccepted(field.accept, file.contentType)) throw apiError(400, "invalid_request", "File does not match the published field contract");
      }
      if (commonSource(widget.resource)) {
        if (Object.keys(req.body || {}).some((key) => key !== "values"))
          throw apiError(400, "invalid_request", "expected declared values");
        const input = validateCommonValues(
          widget.fields || [],
          req.body?.values,
        );
        const result = await commonAction(
          config,
          context.caller.credential,
          entry.snapshot.product,
          widget.resource!,
          widget.action || "create",
          input,
        );
        await recordAudit(context.client, config, {
          actor: context.principal.subject,
          tenant: context.tenant,
          action: "workspace.capability.execute",
          correlationId: correlationIdOf(req),
          details: {
            pluginId: entry.snapshot.pluginId,
            widgetId: widget.id,
            actionId: String(req.query.action),
            product: entry.snapshot.product,
            resource: widget.resource,
          },
        });
        res.json({ completed: true, result });
        return;
      }
      if (!widget.workflowArtifactId) {
        throw apiError(
          409,
          "mutation_not_supported",
          "this form is read-only until it is bound to a workflow artifact",
          {
            widgetId: widget.id,
            reason: "no_workflow_artifact",
          },
        );
      }
      const artifact = await loadArtifact(
        context.client,
        context.tenant,
        widget.workflowArtifactId,
      );
      if (
        !artifact ||
        !artifact.workflowId ||
        !WORKFLOW_ID_RE.test(artifact.workflowId)
      ) {
        throw apiError(
          409,
          "workflow_artifact_not_found",
          "the bound workflow artifact is not executable",
        );
      }
      if (!artifactIsProtected(artifact)) {
        throw apiError(
          409,
          "workflow_not_protected",
          "the bound workflow artifact must be a technical-identity owner-only workflow",
          {
            widgetId: widget.id,
            managedBy: artifact.managedBy || "user",
            accessMode: artifactAccessMode(artifact.settings),
          },
        );
      }
      if (
        widget.workflowArtifactRevision === undefined ||
        !widget.workflowArtifactChecksum
      ) {
        throw apiError(
          409,
          "workflow_artifact_unpinned",
          "this published layout predates artifact pinning; republish the plugin",
        );
      }
      if (!isPinnedArtifactMatch(widget, artifact)) {
        throw apiError(
          409,
          "workflow_artifact_changed",
          "the bound workflow changed after this layout was published; republish the plugin",
          {
            expectedRevision: widget.workflowArtifactRevision,
            currentRevision: artifact.revision ?? null,
          },
        );
      }
      const action = (widget.action || "create") as WidgetAction;
      if (!(WIDGET_ACTIONS as readonly string[]).includes(action)) {
        throw apiError(
          400,
          "invalid_widget",
          "this form action is not allowed",
        );
      }
      const body = (req.body || {}) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw apiError(
          400,
          "invalid_request",
          "the form payload must be a JSON object",
        );
      }
      const envelopeKeys = Object.keys(body);
      const unexpected = envelopeKeys.filter((key) => key !== "values");
      if (unexpected.length) {
        throw apiError(
          400,
          "invalid_request",
          'the form payload must be exactly {"values": {...}}',
          {
            fields: unexpected.slice(0, 10),
          },
        );
      }
      if (
        !body.values ||
        typeof body.values !== "object" ||
        Array.isArray(body.values)
      ) {
        throw apiError(
          400,
          "invalid_request",
          "the form payload requires a values object",
        );
      }
      const input = validateCommonValues(widget.fields || [], body.values);
      const fields = widget.fields || [];
      const allowed = new Set(fields.map((field) => field.name));
      const extra = Object.keys(input).filter((key) => !allowed.has(key));
      if (extra.length) {
        throw apiError(
          400,
          "invalid_request",
          "the form payload contains undeclared field(s)",
          { fields: extra.slice(0, 10) },
        );
      }
      const values: Record<string, string | number | boolean> = {};
      for (const field of fields) {
        const raw = input[field.name];
        if (raw === undefined || raw === null || raw === "") {
          if (field.required)
            throw apiError(
              400,
              "field_required",
              `field "${field.name}" is required`,
              { field: field.name },
            );
          continue;
        }
        if (field.type === "checkbox") {
          values[field.name] = raw as boolean;
          continue;
        }
        if (field.type === "number") {
          if (typeof raw !== "number" || !Number.isFinite(raw)) {
            throw apiError(
              400,
              "invalid_request",
              `field "${field.name}" must be a finite number`,
              { field: field.name },
            );
          }
          values[field.name] = raw;
          continue;
        }
        if (typeof raw !== "string") {
          throw apiError(
            400,
            "invalid_request",
            `field "${field.name}" must be a string`,
            { field: field.name },
          );
        }
        if (raw.length > FORM_TEXT_MAX) {
          throw apiError(
            400,
            "invalid_request",
            `field "${field.name}" must be ≤${FORM_TEXT_MAX} characters`,
            { field: field.name },
          );
        }
        values[field.name] = raw;
      }
      if (!context.caller.credential) {
        throw apiError(
          403,
          "user_token_required",
          "a verified user credential is required to execute a workflow action",
        );
      }
      const submittedAt = new Date().toISOString();
      const payload = {
        pluginId: id,
        widgetId: widget.id,
        product: entry.snapshot.product,
        resource: widget.resource ?? null,
        action,
        submittedBy: context.principal.subject,
        submittedAt,
        fields: values,
      };
      // Library delegation (no direct Tier-1 SDK call here): the workflow
      // capability re-checks tenant/ownership, the approved revision+checksum and
      // the live Tier-1 graph before executing with the caller's credential.
      const result = await executeWorkflowArtifactForPlugin(
        config,
        context.caller,
        widget.workflowArtifactId,
        payload,
        {
          pluginId: id,
          widgetId: widget.id,
          tenant: context.tenant,
          roles: entry.effectiveRoles,
          expectedRevision: widget.workflowArtifactRevision,
          expectedChecksum: widget.workflowArtifactChecksum as string,
          correlationId: correlationIdOf(req),
        },
      );
      const executionRecord = (result.execution || {}) as Record<
        string,
        unknown
      >;
      const executionId = String(
        executionRecord.executionId || executionRecord.id || "",
      ).slice(0, 128);
      await recordAudit(context.client, config, {
        actor: context.principal.subject,
        tenant: context.tenant,
        action: "workspace.widget.execute",
        correlationId: correlationIdOf(req),
        details: {
          pluginId: id,
          widgetId: widget.id,
          actionId: String(req.query.action),
          artifactId: result.artifactId,
          artifactRevision: result.revision,
          executionId: executionId || null,
        },
      });
      res.json({
        pluginId: id,
        widgetId: widget.id,
        artifactId: result.artifactId,
        artifactRevision: result.revision,
        artifactChecksum: result.checksum,
        ...(executionId ? { executionId } : {}),
        submittedAt,
        execution: result.execution,
      });
    }),
  );

  // ---- members ----
  app.get(
    `${base}/members`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      await ensureAdminMembership(
        context.client,
        config,
        context.tenant,
        context.principal,
        req,
      );
      const pagination = parsePagination(req, config.maxPageSize);
      const result = await queryDocuments<WorkspaceMemberRecord>(
        context.client,
        COLLECTIONS.workspaceMembers,
        {
          where: { tenant: context.tenant },
          orderBy: { field: "updatedAt", direction: "desc" },
          limit: pagination.limit,
          offset: pagination.offset,
        },
      );
      setPageHeaders(res, {
        total: result.total,
        limit: pagination.limit,
        offset: pagination.offset,
        nextCursor: result.nextCursor,
      });
      res.setHeader("cache-control", "no-store");
      res.json({
        items: result.items.map((item) => ({
          subject: item.data.subject,
          roles: item.data.roles,
          productRoles: item.data.productRoles || {},
          updatedBy: item.data.updatedBy,
          updatedAt: item.data.updatedAt,
        })),
        total: result.total,
        limit: pagination.limit,
        offset: pagination.offset,
      });
    }),
  );

  app.put(
    `${base}/members/:subject`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const subject = String(req.params.subject || "").trim();
      if (!MEMBER_SUBJECT_RE.test(subject)) {
        throw apiError(
          400,
          "invalid_request",
          "subject is not a valid member identifier",
        );
      }
      const body = (req.body || {}) as Record<string, unknown>;
      assertBodyKeys(body, ["roles", "productRoles"]);
      if (body.productRoles === undefined)
        throw apiError(
          400,
          "app_membership_required",
          "assign roles separately for each app with productRoles",
        );
      const productRoles = parseProductRoles(body.productRoles);
      const roles = [...new Set(Object.values(productRoles).flat())];
      await ensureWorkspaceCollections(context.client);
      const existing = await loadMember(
        context.client,
        context.tenant,
        subject,
      );
      const now = new Date().toISOString();
      let record: WorkspaceMemberRecord;
      if (existing) {
        record = {
          ...existing,
          roles,
          productRoles,
          updatedBy: context.principal.subject,
          updatedAt: now,
        };
        const document = await getDocumentOrNull<WorkspaceMemberRecord>(
          context.client,
          COLLECTIONS.workspaceMembers,
          existing.id,
        );
        try {
          await context.client.base.updateDocument(
            COLLECTIONS.workspaceMembers,
            existing.id,
            {
              data: record as unknown as Record<string, unknown>,
              ...(document ? { ifVersion: document.version } : {}),
            },
          );
        } catch (error) {
          if (isConflict(error))
            throw apiError(
              409,
              "version_conflict",
              "the member was modified by another request",
            );
          throw error;
        }
      } else {
        record = {
          id: memberDocumentId(context.tenant, subject),
          tenant: context.tenant,
          ...(context.principal.org ? { org: context.principal.org } : {}),
          subject,
          roles,
          productRoles,
          updatedBy: context.principal.subject,
          createdAt: now,
          updatedAt: now,
        };
        try {
          await context.client.base.createDocument(
            COLLECTIONS.workspaceMembers,
            {
              id: record.id,
              data: record as unknown as Record<string, unknown>,
            },
          );
        } catch (error) {
          if (isConflict(error))
            throw apiError(
              409,
              "version_conflict",
              "the member was modified by another request",
            );
          throw error;
        }
      }
      memberRolesCache.delete(`${context.tenant}:${subject}`);
      installListCache.delete(context.tenant);
      await recordAudit(context.client, config, {
        actor: context.principal.subject,
        tenant: context.tenant,
        action: "workspace.member.update",
        correlationId: correlationIdOf(req),
        details: { subject, roles, productRoles },
      });
      res.json({
        member: {
          subject: record.subject,
          roles: record.roles,
          updatedBy: record.updatedBy,
          updatedAt: record.updatedAt,
        },
      });
    }),
  );

  // ---- runtime tokens ----
  app.get(
    `${base}/tokens`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const pagination = parsePagination(req, config.maxPageSize);
      const result = await queryDocuments<WorkspaceTokenRecord>(
        context.client,
        COLLECTIONS.workspaceTokens,
        {
          where: { tenant: context.tenant },
          orderBy: { field: "createdAt", direction: "desc" },
          limit: pagination.limit,
          offset: pagination.offset,
        },
      );
      setPageHeaders(res, {
        total: result.total,
        limit: pagination.limit,
        offset: pagination.offset,
        nextCursor: result.nextCursor,
      });
      res.setHeader("cache-control", "no-store");
      res.json({
        items: result.items
          .filter((item) => item.data.tenant === context.tenant)
          .map((item) => tokenMetadata(item.data)),
        total: result.total,
        limit: pagination.limit,
        offset: pagination.offset,
      });
    }),
  );

  app.post(
    `${base}/tokens`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const body = (req.body || {}) as Record<string, unknown>;
      assertBodyKeys(body, ["product", "name", "expiresInDays"]);
      const product = requireWorkspaceProduct(body.product);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (
        !name ||
        name.length > 120 ||
        /[<>]/.test(name) ||
        /[\u0000-\u001F\u007F]/.test(name)
      ) {
        throw apiError(
          400,
          "invalid_request",
          "name must be 1..120 characters of plain text",
        );
      }
      let expiresInDays = context.limits.tokenDefaultDays;
      if (body.expiresInDays !== undefined) {
        const parsed = Number(body.expiresInDays);
        if (
          !Number.isInteger(parsed) ||
          parsed < 1 ||
          parsed > context.limits.tokenMaxDays
        ) {
          throw apiError(
            400,
            "invalid_request",
            `expiresInDays must be an integer 1..${context.limits.tokenMaxDays}`,
          );
        }
        expiresInDays = parsed;
      }
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const now = new Date();
      const record: WorkspaceTokenRecord = {
        id: randomUUID(),
        tenant: context.tenant,
        ...(context.principal.org ? { org: context.principal.org } : {}),
        product,
        name,
        tokenHash: hashWorkspaceToken(token),
        tokenPrefix: tokenPrefixOf(token),
        createdBy: context.principal.subject,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + expiresInDays * 86400_000,
        ).toISOString(),
      };
      await ensureWorkspaceCollections(context.client);
      await context.client.base.createDocument(COLLECTIONS.workspaceTokens, {
        id: record.id,
        data: record as unknown as Record<string, unknown>,
      });
      await recordAudit(context.client, config, {
        actor: context.principal.subject,
        tenant: context.tenant,
        action: "workspace.token.create",
        correlationId: correlationIdOf(req),
        details: {
          tokenId: record.id,
          tokenPrefix: record.tokenPrefix,
          product,
          expiresAt: record.expiresAt,
        },
      });
      // The plaintext token is returned exactly once; only the hash is stored.
      res.status(201).json({ token, ...tokenMetadata(record) });
    }),
  );

  app.delete(
    `${base}/tokens/:id`,
    handler(async (req, res) => {
      const context = await adminContext(req, config);
      const id = String(req.params.id || "").trim();
      const document = await getDocumentOrNull<WorkspaceTokenRecord>(
        context.client,
        COLLECTIONS.workspaceTokens,
        id,
      );
      if (!document || document.data.tenant !== context.tenant) {
        throw apiError(404, "token_not_found", "token not found");
      }
      if (!document.data.revokedAt) {
        try {
          await context.client.base.updateDocument(
            COLLECTIONS.workspaceTokens,
            id,
            {
              data: {
                ...document.data,
                revokedAt: new Date().toISOString(),
              } as unknown as Record<string, unknown>,
              ifVersion: document.version,
            },
          );
        } catch (error) {
          if (isConflict(error))
            throw apiError(
              409,
              "version_conflict",
              "the token was modified by another request",
            );
          throw error;
        }
        await recordAudit(context.client, config, {
          actor: context.principal.subject,
          tenant: context.tenant,
          action: "workspace.token.revoke",
          correlationId: correlationIdOf(req),
          details: { tokenId: id, tokenPrefix: document.data.tokenPrefix },
        });
      }
      res.status(204).end();
    }),
  );

  // ---- runtime (server-to-server only; the browser CORS allowlist does not include this header) ----
  app.get(
    `${base}/runtime/:product`,
    handler(async (req, res) => {
      const product = requireWorkspaceProduct(req.params.product);
      const headerToken = String(req.header("x-workspace-token") || "").trim();
      if (!headerToken || !isValidWorkspaceTokenShape(headerToken)) {
        throw apiError(
          401,
          "token_invalid",
          "a valid X-Workspace-Token is required",
        );
      }
      const candidateHash = hashWorkspaceToken(headerToken);
      const client = serviceClient(config);
      const result = await queryDocuments<WorkspaceTokenRecord>(
        client,
        COLLECTIONS.workspaceTokens,
        {
          where: { tokenHash: candidateHash },
          limit: 1,
        },
      );
      const document = result.items[0];
      if (
        !document ||
        !tokenHashMatches(document.data.tokenHash, candidateHash)
      ) {
        throw apiError(
          401,
          "token_invalid",
          "a valid X-Workspace-Token is required",
        );
      }
      const token = document.data;
      if (!tokenIsUsable(token, product)) {
        throw apiError(
          401,
          "token_invalid",
          "a valid X-Workspace-Token is required",
        );
      }
      const plugins = await queryDocuments<WorkspacePluginRecord>(
        client,
        COLLECTIONS.workspacePlugins,
        {
          where: { tenant: token.tenant, product, status: "published" },
          limit: 500,
        },
      );
      const items: Array<
        ReturnType<typeof publishedView> & { widgets: DecoratedWidget[] }
      > = [];
      for (const item of plugins.items) {
        if (item.data.tenant !== token.tenant) continue;
        const snapshot = await loadSnapshot(
          client,
          token.tenant,
          item.data.id,
          item.data.publishedVersion,
        );
        if (!snapshot) continue;
        items.push({
          ...publishedView(snapshot),
          // A runtime token is a machine credential; it never authorizes a user form action.
          widgets: decorateRuntimeWidgets(snapshot.widgets),
        });
      }
      const lastUsed = token.lastUsedAt ? Date.parse(token.lastUsedAt) : NaN;
      if (!Number.isFinite(lastUsed) || Date.now() - lastUsed > 60_000) {
        try {
          await client.base.updateDocument(
            COLLECTIONS.workspaceTokens,
            token.id,
            {
              data: {
                ...token,
                lastUsedAt: new Date().toISOString(),
              } as unknown as Record<string, unknown>,
              ifVersion: document.version,
            },
          );
        } catch {
          /* usage bookkeeping is best-effort */
        }
      }
      res.setHeader("cache-control", "no-store");
      res.json({ items, total: items.length });
    }),
  );
}
