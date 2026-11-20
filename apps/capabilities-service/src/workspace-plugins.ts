import {
  studioActionError,
  safeActionPath,
  actionReferenceErrors,
  type StudioAction,
} from "./studio-actions";
import { COMMON_SOURCES, commonSource } from "./common-builder";
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Low-code workspace plugin contract for the Tier-2 capabilities service.
 *
 * Code source is versioned data and executes only in the isolated browser
 * worker runtime. This service never evaluates source or accepts credentials
 * or raw connector URLs from a plugin. Tier-3 facts (role names, resource paths, dataset ids) are frozen
 * constants verified against the owning repositories; DX never calls Tier 3.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { CallerPrincipal } from "./auth";
import { apiError } from "./errors";

export const WORKSPACE_PRODUCTS = ["dx", "city", "sos"] as const;
export type WorkspaceProduct = (typeof WORKSPACE_PRODUCTS)[number];

export const WIDGET_TYPES = [
  "text",
  "metric",
  "table",
  "form",
  "heading",
  "divider",
  "alert",
  "navigation",
  "button",
  "tabs",
  "progress",
  "chart",
  "list",
  "map",
  "kanban",
  "timeline",
  "markdown",
  "capability",
  "code",
  "action",
] as const;
export const CAPABILITY_MODULES = [
  "inbox",
  "workspace",
  "people",
  "projects",
  "tasks",
  "forms",
  "reports",
  "quality",
  "ocr",
  "agents",
  "assistant",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const WIDGET_WIDTHS = ["full", "half", "third", "quarter"] as const;
export type WidgetWidth = (typeof WIDGET_WIDTHS)[number];

export const WIDGET_FIELD_TYPES = [
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
] as const;
export type WidgetFieldType = (typeof WIDGET_FIELD_TYPES)[number];

/**
 * Declarative action vocabulary for a bound form. Tier-2 does not interpret
 * these names: the organization-owned, protected workflow artifact defines the
 * domain behaviour. The vocabulary is a strict allowlist so a plugin cannot
 * smuggle a raw URL, credential or arbitrary execution mode.
 */
export const WIDGET_ACTIONS = [
  "create",
  "update",
  "delete",
  "execute",
] as const;
export type WidgetAction = (typeof WIDGET_ACTIONS)[number];

export const PLUGIN_FORMAT = "synapsedx-plugin";
export const PLUGIN_FORMAT_VERSION = 1;
export const TOKEN_PREFIX = "wsp_";

/** Product roles accepted for a workspace audience. `citizen` is public. */
export const PRODUCT_ROLES: Record<WorkspaceProduct, readonly string[]> = {
  // SynapseCity/apps/city-service/src/auth.rs: admin|manager|technician|volunteer|citizen.
  dx: ["admin", "manager", "operator", "moderator", "viewer"],
  city: ["admin", "manager", "technician", "volunteer"],
  // SynapseCitySOS/apps/sos-service/src/auth.rs: admin|manager|operator|responder|volunteer|citizen.
  sos: ["admin", "manager", "operator", "responder", "volunteer"],
};

/** Roles that always mean "public/anonymous"; never installable nor assignable. */
export const PUBLIC_ROLES = [
  "citizen",
  "public",
  "anonymous",
  "guest",
  "unauthenticated",
];

/** Union of member roles an organization may assign (both products). */
export const MEMBER_ROLES: readonly string[] = [
  ...new Set([
    ...PRODUCT_ROLES.dx,
    ...PRODUCT_ROLES.city,
    ...PRODUCT_ROLES.sos,
  ]),
];

/** Roles that may see an `audience: 'admin'` page without being IAM org admin. */
export const ADMIN_TIER_ROLES = ["admin", "manager", "operator"];

export interface ProductResource {
  key: string;
  /** Verified Tier-3 route path; documentation only, never called or returned as a URL. */
  path: string;
  /** Exact Tier-2 dataset this resource is bound to (tenant-scoped read allowlist). */
  dataset: string;
}

/**
 * Exact product resource -> Tier-2 dataset allowlist. A widget resource key is
 * resolved here; the browser can never choose a dataset or a URL.
 */
export const PRODUCT_RESOURCES: Record<
  WorkspaceProduct,
  readonly ProductResource[]
> = {
  dx: [],
  city: [
    { key: "assets", path: "/v1/assets", dataset: "city-assets" },
    { key: "incidents", path: "/v1/incidents", dataset: "city-incidents" },
    {
      key: "maintenance",
      path: "/v1/maintenance",
      dataset: "city-maintenance",
    },
    { key: "iot", path: "/v1/iot/sensors", dataset: "city-iot-sensors" },
    {
      key: "iotReadings",
      path: "/v1/iot/readings",
      dataset: "city-iot-readings",
    },
    { key: "alerts", path: "/v1/alerts", dataset: "city-alerts" },
    { key: "budgets", path: "/v1/budgets", dataset: "city-budgets" },
    {
      key: "budgetTransactions",
      path: "/v1/budgets/transactions",
      dataset: "city-budget-transactions",
    },
    { key: "reports", path: "/v1/reports", dataset: "city-reports" },
    { key: "users", path: "/v1/users", dataset: "city-users" },
    { key: "geofences", path: "/v1/geofences", dataset: "city-geofences" },
    { key: "ingest", path: "/v1/ingest", dataset: "city-ingest-jobs" },
    { key: "files", path: "/v1/files", dataset: "city-files" },
    {
      key: "notifications",
      path: "/v1/notifications",
      dataset: "city-notifications",
    },
  ],
  sos: [
    {
      key: "events",
      path: "/v1/emergency/events",
      dataset: "sos-emergency-events",
    },
    {
      key: "dispatch",
      path: "/v1/emergency/dispatch",
      dataset: "sos-dispatch-orders",
    },
    {
      key: "resources",
      path: "/v1/emergency/resources",
      dataset: "sos-resource-units",
    },
    { key: "sitrep", path: "/v1/emergency/sitrep", dataset: "sos-sitreps" },
    { key: "eop", path: "/v1/emergency/eop", dataset: "sos-eop-plans" },
    {
      key: "afterAction",
      path: "/v1/emergency/after-action",
      dataset: "sos-after-action-reports",
    },
    { key: "hazards", path: "/v1/hazards", dataset: "sos-hazard-layers" },
    {
      key: "hazardIngest",
      path: "/v1/hazards/ingest/status",
      dataset: "sos-hazard-ingest-runs",
    },
    {
      key: "mutualAid",
      path: "/v1/emergency/mutual-aid",
      dataset: "sos-mutual-aid-requests",
    },
  ],
};

for (const product of ["city", "sos"] as const)
  PRODUCT_RESOURCES[product] = [
    ...PRODUCT_RESOURCES[product],
    ...COMMON_SOURCES.map((source) => ({
      key: source.key,
      path: "/v1/capabilities/" + source.path,
      dataset: "common:" + source.key,
    })),
  ];

/**
 * Canonical Tier-3 source repositories for portable plugin bundles.
 *
 * A build artifact is committed to exactly one product repository. Keeping the
 * mapping here prevents a City page from being stamped with SOS (or arbitrary)
 * provenance and then rejected by the owning repository's sync CLI.
 */
export const PRODUCT_REPOSITORIES: Record<WorkspaceProduct, string> = {
  dx: "https://github.com/vku-open-source-2026/SynapseDX",
  city: "https://github.com/vku-open-source-2026/SynapseCity",
  sos: "https://github.com/vku-open-source-2026/SynapseCitySOS",
};

const TIER3_BUNDLE_PATH_RE =
  /^plugins\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.plugin\.json$/;

/** True for the repository-tracked bundle shape accepted by both Tier-3 CLIs. */
export function isTier3BundlePath(value: string): boolean {
  if (!TIER3_BUNDLE_PATH_RE.test(value)) return false;
  const segments = value.split("/");
  return !segments.includes(".") && !segments.includes("..");
}

/** Canonical source provenance derived from the product and plugin slug. */
export function canonicalPluginSource(
  product: WorkspaceProduct,
  slug: string,
): PluginSource {
  return {
    repository: PRODUCT_REPOSITORIES[product],
    path: `plugins/${slug}.plugin.json`,
  };
}

/**
 * Validate that an existing source can be built for its own Tier-3 repository.
 * The stored provenance is never silently rewritten: a mismatching repository
 * or path is an explicit rebuild/repair error.
 */
export function requireBuildSource(
  product: WorkspaceProduct,
  source: PluginSource,
): PluginSource {
  if (
    normalizeRepositoryUrl(source.repository) !==
    normalizeRepositoryUrl(PRODUCT_REPOSITORIES[product])
  ) {
    throw apiError(
      409,
      "source_not_syncable",
      `source.repository must be the ${product} repository (${PRODUCT_REPOSITORIES[product]}) before a Tier-3 build`,
      { expectedRepository: PRODUCT_REPOSITORIES[product] },
    );
  }
  if (!isTier3BundlePath(source.path)) {
    throw apiError(
      409,
      "source_not_syncable",
      'source.path must be a repository-tracked "plugins/**/*.plugin.json" path before a Tier-3 build',
      { expectedPath: "plugins/<name>.plugin.json" },
    );
  }
  return { ...source };
}

function normalizeRepositoryUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

export type PluginAudience = "admin" | "member";
export type PluginStatus = "draft" | "published";

export interface WorkspaceWidgetField {
  name: string;
  label: string;
  type: WidgetFieldType;
  required?: boolean;
  options?: string[];
  optionsResource?: string;
  optionsAction?: string;
  uploadAction?: string;
  editor?: "json" | "schema" | "query" | "geometry";
  selectionPath?: string;
  accept?: string;
  maxBytes?: number;
  defaultValue?: string;
}

export interface StudioCode {
  html: string;
  css: string;
  javascript: string;
  inputs: string[];
  actions: string[];
  height: number;
}

export function studioCodeError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Code must be an object";
  const code = value as Record<string, unknown>;
  if (
    Object.keys(code).some(
      (key) =>
        !["html", "css", "javascript", "inputs", "actions", "height"].includes(
          key,
        ),
    )
  )
    return "Unknown code setting";
  for (const key of ["html", "css", "javascript"]) {
    if (
      typeof code[key] !== "string" ||
      (code[key] as string).length > 32768 ||
      (code[key] as string).includes("\0")
    )
      return "Each source file supports up to 32768 characters";
  }
  if (
    (code.html as string).length +
      (code.css as string).length +
      (code.javascript as string).length >
    65536
  )
    return "Combined code supports up to 65536 characters";
  for (const key of ["inputs", "actions"]) {
    const ids = code[key];
    if (
      !Array.isArray(ids) ||
      ids.length > 20 ||
      ids.some(
        (id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id),
      ) ||
      new Set(ids).size !== ids.length
    )
      return "Choose up to 20 unique widget bindings";
  }
  if (
    !Number.isInteger(code.height) ||
    Number(code.height) < 120 ||
    Number(code.height) > 1200
  )
    return "Height must be 120..1200 pixels";
  return null;
}

export interface WorkspaceWidget {
  chartType?: "bar" | "line" | "area" | "pie" | "donut";
  aggregation?: "none" | "count" | "sum" | "average";
  operation?: StudioAction;
  onClick?: string;
  onLoad?: string;
  onSubmit?: string;
  onRowClick?: string;
  onChange?: string;
  onExport?: string;
  code?: StudioCode;
  groupBy?: string;
  groups?: string[];
  updateForm?: string;
  section?: string;
  presentation?: "inline" | "dialog";
  id: string;
  type: WidgetType;
  title: string;
  text?: string;
  links?: Array<{ label: string; target: string; actionId?: string }>;
  module?: string;
  value?: number;
  resource?: string;
  columns?: string[];
  fields?: WorkspaceWidgetField[];
  action?: WidgetAction;
  width?: WidgetWidth;
  /**
   * Internal binding to an organization-owned workflow artifact managed by the
   * DX workflow capability. Never exported: a bundle carries `workflowRef`
   * instead so an environment-specific artifact id cannot leak.
   */
  workflowArtifactId?: string;
  /**
   * Server-owned pins copied into the published snapshot. They are never
   * accepted from a client and never exported, so an independently edited
   * artifact cannot silently change what a published layout executes.
   */
  workflowArtifactRevision?: number;
  workflowArtifactChecksum?: string;
  /**
   * Stable checksum of the scrubbed portable graph. It is deployment-neutral
   * and is the value exported in `workflowRef.checksum`; the deployed checksum
   * above may differ when credential ids are rebound in another deployment.
   */
  workflowArtifactPortableChecksum?: string;
  /** Portable reference used only inside an import/export bundle. */
  workflowRef?: WorkflowArtifactRef;
}

/** Portable, environment-independent workflow reference for plugin bundles. */
export interface WorkflowArtifactRef {
  name: string;
  slug?: string;
  /** SHA-256 of the scrubbed workflow graph, when known. */
  checksum?: string;
}

export interface PluginSource {
  repository: string;
  path: string;
  revision?: string;
}

export interface WorkspacePluginRecord {
  id: string;
  tenant: string;
  org?: string;
  product: WorkspaceProduct;
  name: string;
  slug: string;
  audience: PluginAudience;
  roles: string[];
  widgets: WorkspaceWidget[];
  status: PluginStatus;
  version: number;
  publishedVersion?: number;
  publishedAt?: string;
  unpublishedAt?: string;
  source?: PluginSource;
  checksum?: string;
  /**
   * Provenance of the last Tier-3 repository build. Management metadata
   * only: never part of the portable plugin definition, never exported or
   * written into build bundles.
   */
  lastBuild?: PluginLastBuild;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Repository sync provenance persisted at build time for the sync chip. */
export interface PluginLastBuild {
  checksum: string;
  repository: string;
  path: string;
  builtAt: string;
}

/** Immutable published layout. Consumers read this, never the editable draft. */
export interface WorkspaceSnapshotRecord {
  id: string;
  tenant: string;
  org?: string;
  pluginId: string;
  product: WorkspaceProduct;
  name: string;
  slug: string;
  audience: PluginAudience;
  roles: string[];
  widgets: WorkspaceWidget[];
  version: number;
  checksum: string;
  publishedBy: string;
  publishedAt: string;
}

export interface WorkspaceInstallRecord {
  id: string;
  tenant: string;
  org?: string;
  pluginId: string;
  product: WorkspaceProduct;
  roles: string[];
  installedBy: string;
  installedAt: string;
  updatedAt: string;
}

export interface WorkspaceMemberRecord {
  id: string;
  tenant: string;
  org?: string;
  subject: string;
  roles: string[];
  productRoles?: Partial<Record<WorkspaceProduct, string[]>>;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTokenRecord {
  id: string;
  tenant: string;
  org?: string;
  product: WorkspaceProduct;
  name: string;
  /** sha256 hex only; never returned by any endpoint or written to audit. */
  tokenHash: string;
  tokenPrefix: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface WorkspaceLimits {
  maxWidgets: number;
  maxFields: number;
  maxColumns: number;
  maxTextLength: number;
  maxPluginsPerOrg: number;
  maxRolesPerPlugin: number;
  tokenDefaultDays: number;
  tokenMaxDays: number;
  widgetDataMaxRows: number;
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

/** Workspace limits are read from the environment per call (tests can override). */
export function workspaceLimits(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceLimits {
  return {
    maxWidgets: boundedInt(env.SYNAPSEDX_WORKSPACE_MAX_WIDGETS, 64, 1, 100),
    maxFields: boundedInt(env.SYNAPSEDX_WORKSPACE_MAX_FIELDS, 30, 1, 100),
    maxColumns: boundedInt(env.SYNAPSEDX_WORKSPACE_MAX_COLUMNS, 20, 1, 50),
    maxTextLength: boundedInt(env.SYNAPSEDX_WORKSPACE_MAX_TEXT, 4000, 1, 20000),
    maxPluginsPerOrg: boundedInt(
      env.SYNAPSEDX_WORKSPACE_MAX_PLUGINS,
      100,
      1,
      2000,
    ),
    maxRolesPerPlugin: boundedInt(env.SYNAPSEDX_WORKSPACE_MAX_ROLES, 12, 1, 50),
    tokenDefaultDays: boundedInt(
      env.SYNAPSEDX_WORKSPACE_TOKEN_DEFAULT_DAYS,
      90,
      1,
      365,
    ),
    tokenMaxDays: boundedInt(
      env.SYNAPSEDX_WORKSPACE_TOKEN_MAX_DAYS,
      365,
      1,
      3650,
    ),
    widgetDataMaxRows: boundedInt(
      env.SYNAPSEDX_WORKSPACE_WIDGET_ROWS,
      100,
      1,
      500,
    ),
  };
}

function tenantKeyOf(value: string | undefined): string {
  return String(value || "")
    .replace(/[^A-Za-z0-9_.@:-]/g, "_")
    .slice(0, 128);
}

/**
 * Organization-first tenant identity.
 *
 * The verified `org` claim is the organization that owns plugins, installs,
 * memberships and runtime tokens. Account/subject are only fallbacks for
 * principals that have no organization claim. This deliberately does not
 * reuse the legacy account-first `principal.tenantKey`.
 */
export function workspaceTenant(principal: CallerPrincipal): string {
  const raw =
    principal.org?.trim() || principal.account?.trim() || principal.subject;
  const tenant = tenantKeyOf(raw);
  if (!tenant)
    throw apiError(
      400,
      "workspace_tenant_required",
      "the caller has no organization or tenant identity",
    );
  return tenant;
}

export function requireWorkspaceOrganization(
  principal: CallerPrincipal,
): string {
  if (!principal.org) {
    throw apiError(
      400,
      "org_required",
      "workspace plugins require a verified organization claim",
    );
  }
  return workspaceTenant(principal);
}

export function isWorkspaceProduct(value: unknown): value is WorkspaceProduct {
  return (
    typeof value === "string" &&
    (WORKSPACE_PRODUCTS as readonly string[]).includes(value)
  );
}

export function requireWorkspaceProduct(value: unknown): WorkspaceProduct {
  if (!isWorkspaceProduct(value)) {
    throw apiError(
      400,
      "invalid_request",
      'product must be "dx", "city" or "sos"',
    );
  }
  return value;
}

export function resourceFor(
  product: WorkspaceProduct,
  key: string,
): ProductResource | undefined {
  return PRODUCT_RESOURCES[product].find((resource) => resource.key === key);
}

/* ------------------------------------------------------------------------- *
 * Strict validators
 * ------------------------------------------------------------------------- */

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw apiError(400, "invalid_plugin", `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertNoExtraKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) {
    throw apiError(
      400,
      "invalid_plugin",
      `${label} has unsupported field(s): ${extra.slice(0, 8).join(", ")}`,
    );
  }
}

const UNSAFE_SCHEME_RE = /(?:javascript|vbscript|data|file|mailto|tel)\s*:/i;
const ANY_URL_SCHEME_RE = /\b[a-z][a-z0-9+.-]*:\/\//i;

function plainText(
  value: unknown,
  label: string,
  maxLength: number,
  options: { allowEmpty?: boolean } = {},
): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const trimmed = text.trim();
  if (!trimmed && !options.allowEmpty)
    throw apiError(400, "invalid_widget", `${label} is required`);
  if (text.length > maxLength)
    throw apiError(
      400,
      "invalid_plugin",
      `${label} must be ≤${maxLength} characters`,
    );
  // Plain text only: no markup, no control characters other than tab/newline.
  if (
    /[<>]/.test(text) ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)
  ) {
    throw apiError(
      400,
      "invalid_widget",
      `${label} must be plain text without HTML/control characters`,
    );
  }
  // Match the console/bundle policy exactly: no executable/data schemes and no
  // arbitrary URLs in any user-visible text (title, text, labels, plugin name).
  if (UNSAFE_SCHEME_RE.test(text) || ANY_URL_SCHEME_RE.test(text)) {
    throw apiError(
      400,
      "invalid_widget",
      `${label} must be plain text without markup, URLs or script schemes`,
    );
  }
  return text;
}

const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function validateSlug(value: unknown): string {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) {
    throw apiError(
      400,
      "invalid_slug",
      'slug must be 2..64 characters of a-z, 0-9 or "-"',
    );
  }
  return slug;
}

export function slugifyPluginName(value: string): string {
  const base = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (base.length >= 2) return base;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `plugin-${digest}`;
}

export function normalizeRoles(
  value: unknown,
  product: WorkspaceProduct,
  limits: WorkspaceLimits,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw apiError(400, "invalid_role", "roles must be a non-empty array");
  }
  if (value.length > limits.maxRolesPerPlugin) {
    throw apiError(
      400,
      "invalid_role",
      `roles must contain at most ${limits.maxRolesPerPlugin} entries`,
    );
  }
  const roles: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string")
      throw apiError(400, "invalid_role", "each role must be a string");
    const role = entry.trim().toLowerCase();
    if (PUBLIC_ROLES.includes(role)) {
      throw apiError(
        400,
        "invalid_role",
        `public/anonymous role "${role}" cannot be a workspace audience`,
      );
    }
    if (!PRODUCT_ROLES[product].includes(role)) {
      throw apiError(
        400,
        "invalid_role",
        `role "${role}" is not a valid ${product} role`,
        {
          allowed: PRODUCT_ROLES[product],
        },
      );
    }
    roles.push(role);
  }
  return [...new Set(roles)];
}

/** Member roles may span both products (an org volunteer can serve City and SOS). */
export function normalizeMemberRoles(
  value: unknown,
  limits: WorkspaceLimits,
): string[] {
  if (!Array.isArray(value))
    throw apiError(400, "invalid_role", "roles must be an array");
  if (value.length > limits.maxRolesPerPlugin * 2) {
    throw apiError(
      400,
      "invalid_role",
      `roles must contain at most ${limits.maxRolesPerPlugin * 2} entries`,
    );
  }
  const roles: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string")
      throw apiError(400, "invalid_role", "each role must be a string");
    const role = entry.trim().toLowerCase();
    if (PUBLIC_ROLES.includes(role)) {
      throw apiError(
        400,
        "invalid_role",
        `public/anonymous role "${role}" cannot be assigned`,
      );
    }
    if (!MEMBER_ROLES.includes(role)) {
      throw apiError(
        400,
        "invalid_role",
        `role "${role}" is not a workspace member role`,
        { allowed: MEMBER_ROLES },
      );
    }
    roles.push(role);
  }
  return [...new Set(roles)];
}

const WIDGET_KEYS = [
  "chartType",
  "aggregation",
  "onLoad",
  "onSubmit",
  "onRowClick",
  "onChange",
  "onExport",
  "operation",
  "onClick",
  "code",
  "links",
  "module",
  "value",
  "section",
  "presentation",
  "groupBy",
  "groups",
  "updateForm",
  "id",
  "type",
  "title",
  "text",
  "resource",
  "columns",
  "fields",
  "action",
  "width",
  "workflowArtifactId",
  "workflowArtifactRevision",
  "workflowArtifactChecksum",
  "workflowArtifactPortableChecksum",
  "workflowRef",
] as const;

const WORKFLOW_ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{8,120}$/;
const WORKFLOW_REF_KEYS = ["name", "slug", "checksum"] as const;

export interface WidgetParseOptions {
  /** Management API: accept the internal same-org artifact binding. */
  allowWorkflowArtifactId?: boolean;
  /** Bundle import: accept the portable reference instead of an artifact id. */
  allowWorkflowRef?: boolean;
}

function validateWorkflowRef(
  value: unknown,
  label: string,
): WorkflowArtifactRef {
  const raw = assertObject(value, label);
  assertNoExtraKeys(raw, WORKFLOW_REF_KEYS, label);
  const name = plainText(raw.name, `${label}.name`, 160);
  let slug: string | undefined;
  if (raw.slug !== undefined) {
    const candidate = String(raw.slug).trim();
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(candidate)) {
      throw apiError(
        400,
        "invalid_widget",
        `${label}.slug has an unsupported format`,
      );
    }
    slug = candidate;
  }
  let checksum: string | undefined;
  if (raw.checksum !== undefined) {
    const candidate = String(raw.checksum).trim();
    if (!/^[a-f0-9]{64}$/.test(candidate)) {
      throw apiError(
        400,
        "invalid_widget",
        `${label}.checksum must be 64 lowercase hex characters`,
      );
    }
    checksum = candidate;
  }
  return { name, ...(slug ? { slug } : {}), ...(checksum ? { checksum } : {}) };
}

function validateWidget(
  input: unknown,
  product: WorkspaceProduct,
  limits: WorkspaceLimits,
  index: number,
  options: WidgetParseOptions,
): WorkspaceWidget {
  const raw = assertObject(input, `widgets[${index}]`);
  assertNoExtraKeys(raw, WIDGET_KEYS, `widgets[${index}]`);
  const id = String(raw.id ?? "").trim();
  if (!WIDGET_ID_RE.test(id)) {
    throw apiError(
      400,
      "invalid_widget",
      `widgets[${index}].id must be 1..64 lowercase letters, digits or "-"`,
    );
  }
  if (!(WIDGET_TYPES as readonly string[]).includes(String(raw.type))) {
    throw apiError(
      400,
      "invalid_widget",
      `widgets[${index}].type must be one of ${WIDGET_TYPES.join(", ")}`,
    );
  }
  const type = raw.type as WidgetType;
  const title = plainText(raw.title, `widgets[${index}].title`, 200);

  let width: WidgetWidth | undefined;
  if (raw.width !== undefined) {
    if (!(WIDGET_WIDTHS as readonly string[]).includes(String(raw.width))) {
      throw apiError(
        400,
        "invalid_widget",
        `widgets[${index}].width must be "full" or "half"`,
      );
    }
    width = raw.width as WidgetWidth;
  }

  const widget: WorkspaceWidget = {
    id,
    type,
    title,
    ...(width ? { width } : {}),
  };
  if (raw.section !== undefined) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(String(raw.section)))
      throw apiError(400, "invalid_widget", "invalid section");
    widget.section = String(raw.section);
  }
  if (raw.presentation !== undefined) {
    if (
      type !== "form" ||
      !["inline", "dialog"].includes(String(raw.presentation))
    )
      throw apiError(400, "invalid_widget", "invalid presentation");
    widget.presentation = raw.presentation as "inline" | "dialog";
  }

  const staticTypes = [
    "text",
    "heading",
    "divider",
    "alert",
    "progress",
    "navigation",
    "button",
    "tabs",
    "capability",
    "markdown",
    "code",
    "action",
  ];
  const textTypes = ["text", "heading", "alert", "markdown"];
  const navigationTypes = ["navigation", "button", "tabs"];
  const allowed = new Set<string>(["id", "type", "title", "width", "section"]);
  if (type === "chart") {
    allowed.add("chartType");
    allowed.add("aggregation");
    if (raw.chartType !== undefined) {
      if (
        !["bar", "line", "area", "pie", "donut"].includes(String(raw.chartType))
      )
        throw apiError(400, "invalid_widget", "Choose a supported chart");
      widget.chartType = raw.chartType as WorkspaceWidget["chartType"];
    }
    if (raw.aggregation !== undefined) {
      if (
        !["none", "count", "sum", "average"].includes(String(raw.aggregation))
      )
        throw apiError(400, "invalid_widget", "Choose an aggregation");
      widget.aggregation = raw.aggregation as WorkspaceWidget["aggregation"];
    }
  }
  for (const key of [
    "onLoad",
    "onSubmit",
    "onRowClick",
    "onChange",
    "onExport",
  ] as const) {
    const types: Record<string, string[]> = {
      onLoad: ["metric", "table", "chart", "list", "map", "kanban", "timeline"],
      onSubmit: ["form"],
      onRowClick: ["table", "list", "map", "kanban", "timeline"],
      onChange: ["kanban"],
      onExport: ["table", "list", "map", "kanban", "timeline"],
    };
    if (types[key].includes(type)) {
      allowed.add(key);
      if (raw[key] !== undefined) {
        if (
          typeof raw[key] !== "string" ||
          !WIDGET_ID_RE.test(raw[key] as string)
        )
          throw apiError(400, "invalid_widget", "Choose a named action");
        widget[key] = raw[key] as string;
      }
    }
  }
  if (textTypes.includes(type)) allowed.add("text");
  if (navigationTypes.includes(type)) allowed.add("links");
  if (type === "action") allowed.add("operation");
  if (type === "button") allowed.add("onClick");
  if (type === "code") allowed.add("code");
  if (type === "capability") allowed.add("module");
  if (type === "progress") allowed.add("value");
  if (!staticTypes.includes(type)) allowed.add("resource");
  if (["table", "chart", "list", "map", "kanban", "timeline"].includes(type))
    allowed.add("columns");
  if (type === "kanban")
    for (const key of ["groupBy", "groups", "updateForm"]) allowed.add(key);
  if (type === "form")
    for (const key of [
      "fields",
      "action",
      "workflowArtifactId",
      "workflowRef",
      "presentation",
    ])
      allowed.add(key);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key))
      throw apiError(
        400,
        "invalid_widget",
        `${type} widgets cannot define ${key}`,
      );
  }
  if (type === "action") {
    const error = studioActionError(raw.operation);
    if (error) throw apiError(400, "invalid_widget", error);
    widget.operation = structuredClone(
      raw.operation as unknown as StudioAction,
    );
    return widget;
  }
  if (type === "button" && raw.onClick !== undefined) {
    if (typeof raw.onClick !== "string" || !WIDGET_ID_RE.test(raw.onClick))
      throw apiError(400, "invalid_widget", "Choose a valid action id");
    widget.onClick = raw.onClick;
  }
  if (type === "code") {
    const error = studioCodeError(raw.code);
    if (error) throw apiError(400, "invalid_widget", error);
    widget.code = structuredClone(raw.code as unknown as StudioCode);
    return widget;
  }
  if (staticTypes.includes(type)) {
    if (textTypes.includes(type))
      widget.text = plainText(
        raw.text,
        `widgets[${index}].text`,
        limits.maxTextLength,
        { allowEmpty: true },
      );
    if (type === "progress") {
      if (
        typeof raw.value !== "number" ||
        !Number.isFinite(raw.value) ||
        raw.value < 0 ||
        raw.value > 100
      )
        throw apiError(400, "invalid_widget", "progress value must be 0..100");
      widget.value = raw.value;
    }
    if (type === "capability") {
      if (!(CAPABILITY_MODULES as readonly unknown[]).includes(raw.module))
        throw apiError(
          400,
          "invalid_widget",
          "capability widgets require an allowlisted common module",
        );
      widget.module = String(raw.module);
    }
    if (navigationTypes.includes(type) && !widget.onClick) {
      if (
        !Array.isArray(raw.links) ||
        raw.links.length < 1 ||
        raw.links.length > 12
      )
        throw apiError(400, "invalid_widget", "navigation needs 1..12 links");
      widget.links = raw.links.map((item) => {
        const link = assertObject(item, "link");
        assertNoExtraKeys(link, ["label", "target", "actionId"], "link");
        if (
          link.actionId !== undefined &&
          (typeof link.actionId !== "string" ||
            !WIDGET_ID_RE.test(link.actionId))
        )
          throw apiError(400, "invalid_widget", "Choose a navigation action");
        const target = String(link.target || "");
        const module =
          target.startsWith("module:") &&
          (CAPABILITY_MODULES as readonly string[]).includes(target.slice(7));
        if (!module && !/^(page|section):[a-z0-9][a-z0-9-]{1,63}$/.test(target))
          throw apiError(
            400,
            "invalid_widget",
            "link target must be a workspace page or H-D-P-I module",
          );
        return {
          label: plainText(link.label, "link.label", 80),
          target,
          ...(link.actionId ? { actionId: String(link.actionId) } : {}),
        };
      });
    }
    return widget;
  }
  if (type === "text") {
    for (const key of [
      "resource",
      "columns",
      "fields",
      "action",
      "workflowArtifactId",
      "workflowRef",
    ] as const) {
      if (raw[key] !== undefined)
        throw apiError(
          400,
          "invalid_widget",
          `text widgets cannot define ${key}`,
        );
    }
    widget.text = plainText(
      raw.text,
      `widgets[${index}].text`,
      limits.maxTextLength,
      { allowEmpty: true },
    );
    return widget;
  }

  if (raw.text !== undefined)
    throw apiError(400, "invalid_widget", `${type} widgets cannot define text`);
  if (type !== "form") {
    for (const key of ["workflowArtifactId", "workflowRef"] as const) {
      if (raw[key] !== undefined)
        throw apiError(
          400,
          "invalid_widget",
          `${type} widgets cannot define ${key}`,
        );
    }
  }
  const resourceKey = String(raw.resource ?? "").trim();
  if (!resourceKey)
    throw apiError(
      400,
      "invalid_widget",
      `widgets[${index}].resource is required`,
    );
  const resource = resourceFor(product, resourceKey);
  if (!resource) {
    throw apiError(
      400,
      "resource_not_allowed",
      `resource "${resourceKey}" is not a ${product} resource`,
      {
        allowed: PRODUCT_RESOURCES[product].map((entry) => entry.key),
      },
    );
  }
  widget.resource = resource.key;

  if (type === "metric") {
    for (const key of ["columns", "fields", "action"] as const) {
      if (raw[key] !== undefined)
        throw apiError(
          400,
          "invalid_widget",
          "metric widgets cannot define " + key,
        );
    }
    return widget;
  }

  if (
    type === "table" ||
    type === "chart" ||
    type === "list" ||
    type === "map" ||
    type === "kanban" ||
    type === "timeline"
  ) {
    for (const key of ["fields", "action"] as const) {
      if (raw[key] !== undefined)
        throw apiError(
          400,
          "invalid_widget",
          `table widgets cannot define ${key}`,
        );
    }
    const columns = raw.columns;
    if (!Array.isArray(columns) || columns.length === 0) {
      throw apiError(
        400,
        "invalid_widget",
        "table widgets require a non-empty columns array",
      );
    }
    if (columns.length > limits.maxColumns) {
      throw apiError(
        400,
        "invalid_widget",
        `table widgets accept at most ${limits.maxColumns} columns`,
      );
    }
    const normalized: string[] = [];
    for (const column of columns) {
      const name = typeof column === "string" ? column.trim() : "";
      if (!COLUMN_RE.test(name)) {
        throw apiError(
          400,
          "invalid_widget",
          `column "${String(column).slice(0, 40)}" is not a valid field name`,
        );
      }
      normalized.push(name);
    }
    widget.columns = [...new Set(normalized)];
    if (type === "kanban") {
      if (raw.groupBy !== undefined) {
        if (
          !COLUMN_RE.test(String(raw.groupBy)) ||
          !widget.columns.includes(String(raw.groupBy))
        )
          throw apiError(
            400,
            "invalid_widget",
            "groupBy must be a declared column",
          );
        widget.groupBy = String(raw.groupBy);
      }
      if (raw.updateForm !== undefined) {
        if (!WIDGET_ID_RE.test(String(raw.updateForm)))
          throw apiError(400, "invalid_widget", "invalid update form");
        widget.updateForm = String(raw.updateForm);
      }
      if (raw.groups !== undefined) {
        if (!Array.isArray(raw.groups) || raw.groups.length > 20)
          throw apiError(400, "invalid_widget", "up to 20 groups supported");
        widget.groups = raw.groups.map((value) =>
          plainText(value, "group", 80),
        );
      }
    }
    return widget;
  }

  // form
  if (raw.columns !== undefined)
    throw apiError(400, "invalid_widget", "form widgets cannot define columns");
  const action = raw.action === undefined ? "create" : String(raw.action);
  if (!(WIDGET_ACTIONS as readonly string[]).includes(action)) {
    throw apiError(
      400,
      "invalid_widget",
      `form widgets only support actions ${WIDGET_ACTIONS.join(", ")}`,
      {
        allowed: WIDGET_ACTIONS,
      },
    );
  }
  if (
    commonSource(widget.resource) &&
    !commonSource(widget.resource)!.operations[action as WidgetAction]
  )
    throw apiError(
      400,
      "invalid_widget",
      "This Common capability does not support the declared action",
    );
  widget.action = action as WidgetAction;
  const fields = raw.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw apiError(
      400,
      "invalid_widget",
      "form widgets require a non-empty fields array",
    );
  }
  if (fields.length > limits.maxFields) {
    throw apiError(
      400,
      "invalid_widget",
      `form widgets accept at most ${limits.maxFields} fields`,
    );
  }
  const normalizedFields: WorkspaceWidgetField[] = [];
  for (const [fieldIndex, field] of fields.entries()) {
    const entry = assertObject(
      field,
      `widgets[${index}].fields[${fieldIndex}]`,
    );
    assertNoExtraKeys(
      entry,
      [
        "name",
        "label",
        "type",
        "required",
        "options",
        "optionsResource",
        "optionsAction",
        "uploadAction",
        "editor",
        "selectionPath",
        "accept",
        "maxBytes",
        "defaultValue",
      ],
      `widgets[${index}].fields[${fieldIndex}]`,
    );
    const name = String(entry.name ?? "").trim();
    if (!FIELD_NAME_RE.test(name)) {
      throw apiError(
        400,
        "invalid_widget",
        `field "${name.slice(0, 40)}" is not a valid name`,
      );
    }
    if (
      !(WIDGET_FIELD_TYPES as readonly string[]).includes(String(entry.type))
    ) {
      throw apiError(
        400,
        "invalid_widget",
        `field "${name}" type must be one of ${WIDGET_FIELD_TYPES.join(", ")}`,
      );
    }
    if (entry.required !== undefined && typeof entry.required !== "boolean") {
      throw apiError(
        400,
        "invalid_widget",
        `field "${name}" required must be a boolean`,
      );
    }
    if (
      entry.type !== "select" &&
      (entry.options !== undefined || entry.optionsResource !== undefined)
    )
      throw apiError(400, "invalid_widget", "options require a select field");
    if (
      entry.options !== undefined &&
      (!Array.isArray(entry.options) ||
        entry.options.length > 100 ||
        entry.options.some(
          (value: unknown) => typeof value !== "string" || value.length > 200,
        ))
    )
      throw apiError(
        400,
        "invalid_widget",
        "options must be a bounded string array",
      );
    if (
      entry.optionsAction !== undefined &&
      (typeof entry.optionsAction !== "string" ||
        !WIDGET_ID_RE.test(entry.optionsAction))
    )
      throw apiError(400, "invalid_widget", "Choose a reference query action");
    if (
      entry.optionsResource !== undefined &&
      !commonSource(String(entry.optionsResource))
    )
      throw apiError(400, "invalid_widget", "unknown reference source");
    if (
      entry.defaultValue !== undefined &&
      (typeof entry.defaultValue !== "string" ||
        entry.defaultValue.length > 4000)
    )
      throw apiError(400, "invalid_widget", "invalid default");
    if (["uploadAction", "accept", "maxBytes"].some(key => entry[key] !== undefined) && entry.type !== "file")
      throw apiError(400, "invalid_widget", "Upload settings require a file field");
    if (entry.uploadAction !== undefined && (typeof entry.uploadAction !== "string" || !WIDGET_ID_RE.test(entry.uploadAction)))
      throw apiError(400, "invalid_widget", "Choose a valid upload action");
    if (entry.accept !== undefined && (typeof entry.accept !== "string" || entry.accept.length > 300 || !entry.accept.split(",").every(type => /^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/.test(type.trim()))))
      throw apiError(400, "invalid_widget", "Accept must contain MIME types separated by commas");
    if (entry.maxBytes !== undefined && (!Number.isInteger(entry.maxBytes) || Number(entry.maxBytes) < 1 || Number(entry.maxBytes) > 20971520))
      throw apiError(400, "invalid_widget", "File limit must be 1..20971520 bytes");
    if (entry.type === "file" && entry.defaultValue)
      throw apiError(400, "invalid_widget", "File fields cannot contain a default upload");
    if (entry.editor !== undefined && (entry.type !== "json" || !["json", "schema", "query", "geometry"].includes(String(entry.editor))))
      throw apiError(400, "invalid_widget", "Choose a JSON, schema, query or geometry editor for a JSON field");
    if (entry.selectionPath !== undefined && (typeof entry.selectionPath !== "string" || !safeActionPath(entry.selectionPath)))
      throw apiError(400, "invalid_widget", "Selected-record binding must be a safe field path");
    normalizedFields.push({
      name,
      label: plainText(
        entry.label,
        `widgets[${index}].fields[${entry.name}].label`,
        200,
      ),
      type: entry.type as WidgetFieldType,
      ...(entry.selectionPath ? { selectionPath: String(entry.selectionPath) } : {}),
      ...(entry.editor ? { editor: entry.editor as WorkspaceWidgetField["editor"] } : {}),
      ...(entry.uploadAction ? { uploadAction: String(entry.uploadAction) } : {}),
      ...(entry.accept ? { accept: String(entry.accept) } : {}),
      ...(entry.maxBytes ? { maxBytes: Number(entry.maxBytes) } : {}),
      ...(entry.options ? { options: entry.options as string[] } : {}),
      ...(entry.optionsAction
        ? { optionsAction: String(entry.optionsAction) }
        : {}),
      ...(entry.optionsResource
        ? { optionsResource: String(entry.optionsResource) }
        : {}),
      ...(entry.defaultValue !== undefined
        ? { defaultValue: String(entry.defaultValue) }
        : {}),
      ...(entry.required === true ? { required: true } : {}),
    });
  }
  const names = normalizedFields.map((field) => field.name);
  if (new Set(names).size !== names.length)
    throw apiError(400, "invalid_widget", "form field names must be unique");
  widget.fields = normalizedFields;

  if (raw.workflowArtifactId !== undefined && raw.workflowRef !== undefined) {
    throw apiError(
      400,
      "invalid_widget",
      "a form binds either workflowArtifactId or workflowRef, not both",
    );
  }
  if (
    raw.workflowArtifactRevision !== undefined ||
    raw.workflowArtifactChecksum !== undefined ||
    raw.workflowArtifactPortableChecksum !== undefined
  ) {
    throw apiError(
      400,
      "invalid_widget",
      "workflowArtifactRevision/workflowArtifactChecksum/workflowArtifactPortableChecksum are server-owned pins and cannot be set",
    );
  }
  if (raw.workflowArtifactId !== undefined) {
    if (!options.allowWorkflowArtifactId) {
      throw apiError(
        400,
        "invalid_widget",
        "workflowArtifactId is not accepted in a portable bundle; use workflowRef",
      );
    }
    const workflowArtifactId = String(raw.workflowArtifactId).trim();
    if (!WORKFLOW_ARTIFACT_ID_RE.test(workflowArtifactId)) {
      throw apiError(
        400,
        "invalid_widget",
        "workflowArtifactId has an unsupported format",
      );
    }
    widget.workflowArtifactId = workflowArtifactId;
  }
  if (raw.workflowRef !== undefined) {
    if (!options.allowWorkflowRef) {
      throw apiError(
        400,
        "invalid_widget",
        "workflowRef is only accepted in an import bundle",
      );
    }
    widget.workflowRef = validateWorkflowRef(
      raw.workflowRef,
      `widgets[${index}].workflowRef`,
    );
  }
  return widget;
}

export function parseWidgets(
  value: unknown,
  product: WorkspaceProduct,
  limits: WorkspaceLimits,
  options: WidgetParseOptions = {},
): WorkspaceWidget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw apiError(400, "invalid_widget", "widgets must be an array");
  if (
    value.filter((w) => !w || typeof w !== "object" || w.type !== "action")
      .length > limits.maxWidgets ||
    value.filter((w) => w && typeof w === "object" && w.type === "action")
      .length > 128
  ) {
    throw apiError(
      400,
      "widget_limit_exceeded",
      `a plugin accepts at most ${limits.maxWidgets} visual widgets and 128 actions`,
      {
        max: limits.maxWidgets,
      },
    );
  }
  const widgets = value.map((entry, index) =>
    validateWidget(entry, product, limits, index, options),
  );
  const ids = widgets.map((widget) => widget.id);
  if (new Set(ids).size !== ids.length)
    throw apiError(400, "invalid_widget", "widget ids must be unique");
  for (const widget of widgets) {
    if (widget.code)
      for (const [key, types] of [
        [
          "inputs",
          ["metric", "table", "chart", "list", "map", "kanban", "timeline"],
        ],
        ["actions", ["form"]],
      ] as const) {
        for (const id of widget.code[key])
          if (
            !widgets.some(
              (item) => item.id === id && types.includes(item.type as never),
            )
          )
            throw apiError(
              400,
              "invalid_widget",
              `Code binding ${id} must reference a matching widget in this page`,
            );
      }
    if (!widget.updateForm) continue;
    const form = widgets.find((form) => form.id === widget.updateForm);
    const group = widget.groupBy || widget.columns?.[1] || "status";
    if (
      !form ||
      form.type !== "form" ||
      form.action !== "update" ||
      form.resource !== widget.resource ||
      !form.fields?.some((field) => field.name === "record_id") ||
      !form.fields?.some((field) => field.name === group)
    )
      throw apiError(
        400,
        "invalid_widget",
        "Kanban updateForm must reference a matching update form with record_id and group fields",
      );
  }
  const actionErrors = actionReferenceErrors(widgets);
  if (actionErrors.length)
    throw apiError(400, "invalid_widget", actionErrors[0]);
  return widgets;
}

const SOURCE_REPOSITORY_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
const SOURCE_PATH_RE = /^[A-Za-z0-9._/-]{1,300}$/;
const SOURCE_REVISION_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Provenance only. DX never clones, fetches or resolves this URL. */
export function parseSource(value: unknown): PluginSource {
  const raw = assertObject(value, "source");
  assertNoExtraKeys(raw, ["repository", "path", "revision"], "source");
  const repository = String(raw.repository ?? "").trim();
  if (!SOURCE_REPOSITORY_RE.test(repository)) {
    throw apiError(
      400,
      "invalid_source",
      "source.repository must be a public GitHub HTTPS repository URL",
    );
  }
  const path = String(raw.path ?? "").trim();
  if (
    !path ||
    !SOURCE_PATH_RE.test(path) ||
    path.startsWith("/") ||
    path.includes("//")
  ) {
    throw apiError(
      400,
      "invalid_source",
      "source.path must be a safe relative path",
    );
  }
  if (path.split("/").includes("..")) {
    throw apiError(
      400,
      "invalid_source",
      "source.path must not traverse directories",
    );
  }
  let revision: string | undefined;
  if (raw.revision !== undefined) {
    const candidate = String(raw.revision).trim();
    if (!SOURCE_REVISION_RE.test(candidate)) {
      throw apiError(
        400,
        "invalid_source",
        "source.revision must be 1..100 characters of [A-Za-z0-9._-]",
      );
    }
    revision = candidate;
  }
  return { repository, path, ...(revision ? { revision } : {}) };
}

export interface PluginDefinition {
  product: WorkspaceProduct;
  name: string;
  slug: string;
  audience: PluginAudience;
  roles: string[];
  widgets: WorkspaceWidget[];
}

const PLUGIN_KEYS = [
  "product",
  "name",
  "slug",
  "audience",
  "roles",
  "widgets",
] as const;

/**
 * Validate a plugin definition (create, update-merged body or bundle plugin).
 * Unknown keys are rejected so a bundle cannot smuggle tenant ids, tokens,
 * membership, audit or server metadata into storage.
 */
export function parsePluginDefinition(
  value: unknown,
  limits: WorkspaceLimits,
  options: WidgetParseOptions = {},
): PluginDefinition {
  const raw = assertObject(value, "plugin");
  assertNoExtraKeys(raw, PLUGIN_KEYS, "plugin");
  const product = requireWorkspaceProduct(raw.product);
  const name = plainText(raw.name, "name", 160).trim();
  const slug =
    raw.slug === undefined || raw.slug === ""
      ? slugifyPluginName(name)
      : validateSlug(raw.slug);
  const audience = String(raw.audience ?? "");
  if (audience !== "admin" && audience !== "member") {
    throw apiError(
      400,
      "invalid_plugin",
      'audience must be "admin" or "member"',
    );
  }
  const roles = normalizeRoles(raw.roles, product, limits);
  const widgets = parseWidgets(raw.widgets, product, limits, options);
  return { product, name, slug, audience, roles, widgets };
}

/* ------------------------------------------------------------------------- *
 * Canonical JSON + checksums
 * ------------------------------------------------------------------------- */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value ?? null);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const node = value as Record<string, unknown>;
  const keys = Object.keys(node).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(node[key])}`).join(",")}}`;
}

export function checksumOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export interface PluginBundle {
  format: typeof PLUGIN_FORMAT;
  formatVersion: typeof PLUGIN_FORMAT_VERSION;
  plugin: PluginDefinition;
  source?: PluginSource;
  checksum?: string;
}

const BUNDLE_KEYS = [
  "format",
  "formatVersion",
  "plugin",
  "source",
  "checksum",
] as const;

/** An artifact reference resolved for export (never the environment-specific id). */
export interface WorkflowArtifactRefSource extends WorkflowArtifactRef {}

/** Definition without the internal artifact binding, used for checksums/exports. */
export function portableDefinition(
  plugin: WorkspacePluginRecord,
  refs: Map<string, WorkflowArtifactRefSource>,
): PluginDefinition {
  const widgets = plugin.widgets.map((widget): WorkspaceWidget => {
    const {
      workflowArtifactRevision: _revision,
      workflowArtifactChecksum: _checksum,
      workflowArtifactPortableChecksum: _portableChecksum,
      workflowRef: _previousRef,
      ...base
    } = widget;
    if (widget.type !== "form" || !widget.workflowArtifactId) return base;
    const ref = refs.get(widget.workflowArtifactId);
    if (!ref) {
      throw apiError(
        409,
        "workflow_artifact_not_found",
        "a bound workflow artifact no longer exists; rebind or remove the form before export",
      );
    }
    // The published snapshot pinned the reviewed graph. Exporting a newer
    // checksum would launder later artifact edits into a "reviewed" bundle.
    if (
      widget.workflowArtifactPortableChecksum !== undefined &&
      (ref.checksum === undefined ||
        ref.checksum !== widget.workflowArtifactPortableChecksum)
    ) {
      throw apiError(
        409,
        "artifact_out_of_sync",
        "the bound workflow artifact changed after this layout was published; republish the plugin before export or build",
        { widgetId: widget.id },
      );
    }
    const { workflowArtifactId: _internal, ...rest } = base;
    return {
      ...rest,
      workflowRef: {
        ...ref,
        ...(widget.workflowArtifactPortableChecksum
          ? { checksum: widget.workflowArtifactPortableChecksum }
          : widget.workflowArtifactChecksum
            ? { checksum: widget.workflowArtifactChecksum }
            : {}),
      },
    };
  });
  return {
    product: plugin.product,
    name: plugin.name,
    slug: plugin.slug,
    audience: plugin.audience,
    roles: [...plugin.roles],
    widgets,
  };
}

/** Export never includes tenant, ids, tokens, membership, audit or timestamps. */
export function buildBundle(
  plugin: WorkspacePluginRecord,
  refs: Map<string, WorkflowArtifactRefSource> = new Map(),
  sourceOverride?: PluginSource,
): PluginBundle {
  const definition = portableDefinition(plugin, refs);
  const source = sourceOverride ?? plugin.source;
  return {
    format: PLUGIN_FORMAT,
    formatVersion: PLUGIN_FORMAT_VERSION,
    plugin: definition,
    ...(source ? { source } : {}),
    checksum: checksumOf(definition),
  };
}

export function parseBundle(
  value: unknown,
  limits: WorkspaceLimits,
): PluginBundle {
  const raw = assertObject(value, "bundle");
  assertNoExtraKeys(raw, BUNDLE_KEYS, "bundle");
  if (raw.format !== PLUGIN_FORMAT) {
    throw apiError(400, "invalid_bundle", `format must be "${PLUGIN_FORMAT}"`);
  }
  if (raw.formatVersion !== PLUGIN_FORMAT_VERSION) {
    throw apiError(
      400,
      "invalid_bundle",
      `formatVersion must be ${PLUGIN_FORMAT_VERSION}`,
    );
  }
  if (
    !raw.plugin ||
    typeof raw.plugin !== "object" ||
    Array.isArray(raw.plugin)
  ) {
    throw apiError(400, "invalid_bundle", "plugin is required");
  }
  const plugin = parsePluginDefinition(raw.plugin, limits, {
    allowWorkflowRef: true,
  });
  const source =
    raw.source === undefined || raw.source === null
      ? undefined
      : parseSource(raw.source);
  let checksum: string | undefined;
  if (raw.checksum !== undefined) {
    if (
      typeof raw.checksum !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(raw.checksum)
    ) {
      throw apiError(
        400,
        "invalid_bundle",
        'checksum must look like "sha256:<64 lowercase hex>"',
      );
    }
    const expected = checksumOf(raw.plugin);
    if (expected !== raw.checksum) {
      throw apiError(
        400,
        "bundle_checksum_mismatch",
        "the bundle checksum does not match its plugin definition",
        {
          expected,
        },
      );
    }
    checksum = raw.checksum;
  }
  return {
    format: PLUGIN_FORMAT,
    formatVersion: PLUGIN_FORMAT_VERSION,
    plugin,
    ...(source ? { source } : {}),
    ...(checksum ? { checksum } : {}),
  };
}

/* ------------------------------------------------------------------------- *
 * Roles
 * ------------------------------------------------------------------------- */

export function intersectRoles(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const allowed = new Set(right.map((value) => value.toLowerCase()));
  return [
    ...new Set(
      left
        .map((value) => value.toLowerCase())
        .filter((value) => allowed.has(value)),
    ),
  ];
}

/**
 * Effective roles a caller may use for one installation.
 * Membership is the ceiling; the install may narrow it further (never widen).
 */
export function effectiveRoles(
  memberRoles: readonly string[],
  installationRoles: readonly string[] | undefined,
  pluginRoles: readonly string[],
): string[] {
  return intersectRoles(
    memberRoles,
    installationRoles?.length ? installationRoles : pluginRoles,
  );
}

/* ------------------------------------------------------------------------- *
 * Runtime tokens
 * ------------------------------------------------------------------------- */

const TOKEN_RE = /^wsp_[A-Za-z0-9_-]{43}$/;

export function isValidWorkspaceTokenShape(value: string): boolean {
  return TOKEN_RE.test(value);
}

export function hashWorkspaceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenPrefixOf(token: string): string {
  return token.slice(0, 12);
}

/** Timing-safe comparison of two sha256 hex digests. */
export function tokenHashMatches(
  expectedHex: string,
  candidateHex: string,
): boolean {
  if (
    !/^[a-f0-9]{64}$/.test(expectedHex) ||
    !/^[a-f0-9]{64}$/.test(candidateHex)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(expectedHex, "hex"),
    Buffer.from(candidateHex, "hex"),
  );
}

export interface TokenMetadataView {
  id: string;
  product: WorkspaceProduct;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export function tokenMetadata(record: WorkspaceTokenRecord): TokenMetadataView {
  return {
    id: record.id,
    product: record.product,
    name: record.name,
    tokenPrefix: record.tokenPrefix,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
    ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
  };
}

export function tokenIsUsable(
  record: WorkspaceTokenRecord,
  product: WorkspaceProduct,
  now = new Date(),
): boolean {
  if (record.product !== product) return false;
  if (record.revokedAt) return false;
  const expires = Date.parse(record.expiresAt);
  return Number.isFinite(expires) && expires > now.getTime();
}

/* ------------------------------------------------------------------------- *
 * Views
 * ------------------------------------------------------------------------- */

export interface PluginView {
  id: string;
  product: WorkspaceProduct;
  name: string;
  slug: string;
  audience: PluginAudience;
  roles: string[];
  widgets: WorkspaceWidget[];
  status: PluginStatus;
  version: number;
  publishedVersion?: number;
  publishedAt?: string;
  /** Repository sync provenance of the last Tier-3 build, if any. */
  lastBuild?: PluginLastBuild;
  createdAt: string;
  updatedAt: string;
}

export function pluginView(plugin: WorkspacePluginRecord): PluginView {
  return {
    id: plugin.id,
    product: plugin.product,
    name: plugin.name,
    slug: plugin.slug,
    audience: plugin.audience,
    roles: [...plugin.roles],
    widgets: plugin.widgets,
    status: plugin.status,
    version: plugin.version,
    ...(plugin.publishedVersion !== undefined
      ? { publishedVersion: plugin.publishedVersion }
      : {}),
    ...(plugin.publishedAt ? { publishedAt: plugin.publishedAt } : {}),
    ...(plugin.lastBuild ? { lastBuild: plugin.lastBuild } : {}),
    createdAt: plugin.createdAt,
    updatedAt: plugin.updatedAt,
  };
}

export interface PublishedPluginView {
  id: string;
  product: WorkspaceProduct;
  name: string;
  slug: string;
  audience: PluginAudience;
  roles: string[];
  widgets: WorkspaceWidget[];
  version: number;
  publishedVersion: number;
  publishedAt: string;
  checksum: string;
}

export function publishedView(
  snapshot: WorkspaceSnapshotRecord,
): PublishedPluginView {
  return {
    id: snapshot.pluginId,
    product: snapshot.product,
    name: snapshot.name,
    slug: snapshot.slug,
    audience: snapshot.audience,
    roles: [...snapshot.roles],
    // Server-owned artifact pins never leave the server.
    widgets: snapshot.widgets.map((widget) => {
      const {
        workflowArtifactRevision: _revision,
        workflowArtifactChecksum: _checksum,
        workflowArtifactPortableChecksum: _portableChecksum,
        ...rest
      } = widget;
      return rest;
    }),
    version: snapshot.version,
    publishedVersion: snapshot.version,
    publishedAt: snapshot.publishedAt,
    checksum: snapshot.checksum,
  };
}

/** Deterministic, id-safe document id from logical parts. */
export function workspaceDocId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 40);
  return `${prefix}-${digest}`;
}
