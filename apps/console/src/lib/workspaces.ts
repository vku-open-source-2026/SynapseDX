// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Workspace plugin schema, defensive validation and strict response parsing.
 *
 * The types below mirror the DX capability contract documented in
 * `DX_BACKEND_REPORT.md`. Responses are parsed strictly: a backend shape
 * mismatch throws a visible error instead of being silently coerced. This
 * module is pure (no DOM, no network) so the same rules run in the builder,
 * the member workspace and the regression tests.
 */
export const WORKSPACE_API_BASE = '/v1/capabilities/workspaces';
export const WORKFLOW_ARTIFACTS_API = '/v1/capabilities/workflow-artifacts';
export const PLUGIN_BUNDLE_FORMAT = 'synapsedx-plugin';
export const PLUGIN_BUNDLE_VERSION = 1;
export const MAX_WIDGETS = 40;
export const MAX_FIELDS = 30;
export const MAX_COLUMNS = 20;
export const MAX_DATA_ROWS = 100;
export const MAX_BUNDLE_BYTES = 256 * 1024;
export const MAX_TEXT_LENGTH = 4000;

export const SAFE_WIDGET_TYPES = ['text', 'metric', 'table', 'form'] as const;
export type WorkspaceWidgetType = (typeof SAFE_WIDGET_TYPES)[number];
export type WorkspaceProduct = 'city' | 'sos';
export type WorkspaceAudience = 'admin' | 'member';
export type WorkspaceWidth = 'full' | 'half';
export type WorkspaceFieldType = 'text' | 'number' | 'textarea';
export type WorkspaceFormAction = 'create' | 'update' | 'delete' | 'execute';
export type WorkspaceStatus = 'draft' | 'published';

export const WORKSPACE_PRODUCTS: WorkspaceProduct[] = ['city', 'sos'];
export const FORM_ACTIONS: WorkspaceFormAction[] = ['create', 'update', 'delete', 'execute'];
export const PUBLIC_ROLES = new Set(['public', 'anonymous', 'guest', 'citizen', 'everyone', 'all']);

const WORKFLOW_ARTIFACT_ID = /^[A-Za-z0-9_-]{8,120}$/;

export interface WorkspaceField {
  name: string;
  label: string;
  type: WorkspaceFieldType;
  required?: boolean;
}

export interface WorkspaceWidget {
  id: string;
  type: WorkspaceWidgetType;
  title: string;
  text?: string;
  resource?: string;
  columns?: string[];
  fields?: WorkspaceField[];
  action?: WorkspaceFormAction;
  /** Form only: same-organization workflow artifact executed by DX/Tier 1. */
  workflowArtifactId?: string;
  /** Server-owned pins copied into a published snapshot; never sent by the client. */
  workflowArtifactRevision?: number;
  workflowArtifactChecksum?: string;
  /** Portable bundle reference; resolved to workflowArtifactId by the server on import. */
  workflowRef?: WorkflowArtifactRef;
  width?: WorkspaceWidth;
}

export interface WorkflowArtifactRef {
  name: string;
  slug?: string;
  checksum?: string;
}

/** Installed widgets carry the backend's authorization decision. */
export interface RuntimeWidget extends WorkspaceWidget {
  /** Only present/true when the backend authorized this form for the caller. */
  canSubmit?: boolean;
  /** Server-provided reason when canSubmit is false (global SDK or per-org identity). */
  canSubmitReason?: string;
}

export interface WorkspacePlugin {
  id: string;
  product: WorkspaceProduct;
  name: string;
  slug: string;
  audience: WorkspaceAudience;
  roles: string[];
  widgets: RuntimeWidget[];
  status: WorkspaceStatus;
  version: number;
  publishedVersion?: number;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  /** Admin management metadata from the plugin list. */
  installed: boolean;
  installedRoles?: string[];
}

export interface InstalledPlugin {
  id: string;
  product: WorkspaceProduct;
  name: string;
  slug: string;
  audience: WorkspaceAudience;
  roles: string[];
  widgets: RuntimeWidget[];
  version: number;
  publishedVersion: number;
  publishedAt: string;
  checksum: string;
  installedAt?: string;
  installationRoles?: string[];
}

export interface WorkflowExecutionReadiness {
  ready: boolean;
  installedVersion: string | null;
  minimumVersion: string;
  requirement: string;
  canSubmit: boolean;
}

export interface WorkflowReadiness {
  workflowExecution: WorkflowExecutionReadiness;
  pluginFormsCanSubmit: boolean;
  directManagementExecute?: boolean;
}

export interface CatalogMutation {
  formExecution: boolean;
  formRequiresWorkflowArtifact: boolean;
  directDatasetWrites: boolean;
  reason?: string;
}

export interface WorkspaceLimits {
  maxWidgets: number;
  maxFields: number;
  maxColumns: number;
  maxTextLength: number;
  maxPluginsPerOrg: number;
  maxRolesPerPlugin?: number;
  tokenDefaultDays: number;
  tokenMaxDays: number;
  widgetDataMaxRows: number;
}

export interface CatalogResource {
  key: string;
  path?: string;
  dataset?: string;
}

export interface CatalogProduct {
  product: WorkspaceProduct;
  roles: string[];
  publicRoles: string[];
  resources: CatalogResource[];
  widgetTypes: WorkspaceWidgetType[];
  actionTypes: WorkspaceFormAction[];
}

export interface WorkspaceOrgReadiness {
  ready: boolean;
  reason?: string;
  requirement: string;
  configured: boolean;
  verified: boolean;
}

export interface WorkspaceCatalog {
  products: CatalogProduct[];
  widgetTypes: WorkspaceWidgetType[];
  actionTypes: WorkspaceFormAction[];
  audiences: WorkspaceAudience[];
  mutation: CatalogMutation;
  workflowExecution?: WorkflowExecutionReadiness;
  workflowOrgReadiness?: WorkspaceOrgReadiness;
  limits: WorkspaceLimits;
  roles: string[];
}

export interface WorkspaceMember {
  subject: string;
  roles: string[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface WorkspaceTokenMetadata {
  id: string;
  product: WorkspaceProduct;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface WorkflowArtifactSummary {
  id: string;
  name: string;
  description?: string;
  slug?: string;
  active: boolean;
  revision: number;
  nodeCount: number;
  syncState?: 'ready' | 'pending' | 'failed';
  updatedAt?: string;
}

export interface WidgetData {
  rows: Array<Record<string, unknown>>;
  total: number;
  columns: string[];
}

export interface PluginBundlePlugin {
  product: WorkspaceProduct;
  name: string;
  slug: string;
  audience: WorkspaceAudience;
  roles: string[];
  widgets: WorkspaceWidget[];
}

export interface PluginBundleSource {
  repository: string;
  path: string;
  revision?: string;
}

export interface PluginBundle {
  format: typeof PLUGIN_BUNDLE_FORMAT;
  formatVersion: typeof PLUGIN_BUNDLE_VERSION;
  plugin: PluginBundlePlugin;
  source?: PluginBundleSource;
  checksum?: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

export interface PluginValidationOptions {
  /** Catalog roles for the plugin product, when the catalog is reachable. */
  allowedRoles?: string[];
  /** Validate a portable bundle definition instead of a management draft. */
  portable?: boolean;
}

// ---------------------------------------------------------------------------
// primitive guards
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isWorkspaceProduct(value: unknown): value is WorkspaceProduct {
  return value === 'city' || value === 'sos';
}

export function isWorkspaceWidgetType(value: unknown): value is WorkspaceWidgetType {
  return typeof value === 'string' && (SAFE_WIDGET_TYPES as readonly string[]).includes(value);
}

export function isFormAction(value: unknown): value is WorkspaceFormAction {
  return typeof value === 'string' && (FORM_ACTIONS as readonly string[]).includes(value);
}

const UNSAFE_SCHEME = /(?:javascript|vbscript|data)\s*:/i;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Plain text only: no markup, no control characters, no javascript/vbscript/
 * data schemes. Ordinary URLs are accepted because the backend plain-text
 * contract accepts them; they are always rendered as inert text, never links.
 */
export function isSafePlainText(value: string, max = MAX_TEXT_LENGTH): boolean {
  if (typeof value !== 'string' || value.length > max) return false;
  if (/[<>]/.test(value)) return false;
  if (CONTROL_CHARS.test(value)) return false;
  if (UNSAFE_SCHEME.test(value)) return false;
  return true;
}

export function isSafeSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(value);
}

export function isSafeWidgetId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

export function isSafeResourceKey(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}

export function isSafeColumnName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
}

export function isSafeFieldName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
}

export function isSafeRole(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) && !PUBLIC_ROLES.has(value.toLowerCase());
}

export function isSafeWorkflowArtifactId(value: string): boolean {
  return WORKFLOW_ARTIFACT_ID.test(value);
}

export function slugify(value: string): string {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || 'workspace-page';
}

export function uniqueStrings(value: unknown, predicate: (item: string) => boolean = () => true): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || seen.has(text) || !predicate(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

// ---------------------------------------------------------------------------
// widget / plugin validation
// ---------------------------------------------------------------------------

export function validateWidget(input: unknown, index = 0, options: { portable?: boolean } = {}): ValidationIssue[] {
  const path = `widgets[${index}]`;
  const issues: ValidationIssue[] = [];
  const push = (field: string, message: string) => issues.push({ path: `${path}.${field}`, message });

  if (!isRecord(input)) {
    issues.push({ path, message: 'widget must be an object' });
    return issues;
  }

  const type = input.type;
  if (!isWorkspaceWidgetType(type)) {
    push('type', 'widget type must be text, metric, table or form');
    return issues;
  }

  const allowed = new Set(['id', 'type', 'title', 'width']);
  if (type === 'text') allowed.add('text');
  else allowed.add('resource');
  if (type === 'table') allowed.add('columns');
  if (type === 'form') {
    allowed.add('fields');
    allowed.add('action');
    allowed.add(options.portable ? 'workflowRef' : 'workflowArtifactId');
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) push(key, `"${key}" is not allowed on a ${type} widget`);
  }

  if (typeof input.id !== 'string' || !isSafeWidgetId(input.id)) {
    push('id', 'id must be lowercase letters, digits or "-"');
  }
  if (typeof input.title !== 'string' || !input.title.trim()) {
    push('title', 'title is required');
  } else if (!isSafePlainText(input.title, 200)) {
    push('title', 'title must be plain text without markup, URLs or script schemes');
  }
  if (input.width !== undefined && input.width !== 'full' && input.width !== 'half') {
    push('width', 'width must be "full" or "half"');
  }

  if (type === 'text') {
    if (input.text !== undefined) {
      if (typeof input.text !== 'string') push('text', 'text must be a string');
      else if (!isSafePlainText(input.text, MAX_TEXT_LENGTH)) {
        push('text', 'text must be plain text without markup, URLs or script schemes');
      }
    }
  }

  if (type !== 'text') {
    if (typeof input.resource !== 'string' || !isSafeResourceKey(input.resource)) {
      push('resource', 'resource must be a catalog key such as "assets" (never a URL)');
    }
  }

  if (type === 'table') {
    if (!Array.isArray(input.columns) || input.columns.length === 0) {
      push('columns', 'table widgets need at least one column');
    } else {
      if (input.columns.length > MAX_COLUMNS) push('columns', `at most ${MAX_COLUMNS} columns are allowed`);
      const seen = new Set<string>();
      input.columns.forEach((column, columnIndex) => {
        if (typeof column !== 'string' || !isSafeColumnName(column)) {
          push(`columns[${columnIndex}]`, 'column must be a plain field name');
          return;
        }
        if (seen.has(column)) push(`columns[${columnIndex}]`, `duplicate column "${column}"`);
        seen.add(column);
      });
    }
  }

  if (type === 'form') {
    if (input.action !== undefined && !isFormAction(input.action)) {
      push('action', 'form action must be create, update, delete or execute');
    }
    if (options.portable) {
      if (input.workflowRef !== undefined) {
        if (!isRecord(input.workflowRef)) {
          push('workflowRef', 'workflowRef must be an object');
        } else {
          for (const key of Object.keys(input.workflowRef)) {
            if (!['name', 'slug', 'checksum'].includes(key)) {
              push(`workflowRef.${key}`, `"${key}" is not allowed on workflowRef`);
            }
          }
          const name = input.workflowRef.name;
          if (typeof name !== 'string' || !name.trim() || !isSafePlainText(name, 160)) {
            push('workflowRef.name', 'workflowRef.name must be plain text');
          }
          const refSlug = input.workflowRef.slug;
          if (refSlug !== undefined && (typeof refSlug !== 'string' || !isSafeSlug(refSlug))) {
            push('workflowRef.slug', 'workflowRef.slug must be a lowercase slug');
          }
          const checksum = input.workflowRef.checksum;
          if (checksum !== undefined && (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum))) {
            push('workflowRef.checksum', 'workflowRef.checksum must be 64 lowercase hex characters');
          }
        }
      }
    } else if (input.workflowArtifactId !== undefined) {
      if (
        typeof input.workflowArtifactId !== 'string' ||
        !isSafeWorkflowArtifactId(input.workflowArtifactId)
      ) {
        push('workflowArtifactId', 'workflowArtifactId must be a catalog artifact id');
      }
    }
    if (!Array.isArray(input.fields) || input.fields.length < 1) {
      push('fields', 'a form needs at least one field');
    } else if (input.fields.length > MAX_FIELDS) {
      push('fields', `at most ${MAX_FIELDS} fields are allowed`);
    } else {
      const seen = new Set<string>();
      input.fields.forEach((field, fieldIndex) => {
        const fieldPath = `fields[${fieldIndex}]`;
        if (!isRecord(field)) {
          push(fieldPath, 'field must be an object');
          return;
        }
        for (const key of Object.keys(field)) {
          if (!['name', 'label', 'type', 'required'].includes(key)) {
            push(`${fieldPath}.${key}`, `"${key}" is not allowed on a field`);
          }
        }
        if (typeof field.name !== 'string' || !isSafeFieldName(field.name)) {
          push(`${fieldPath}.name`, 'field name must be an identifier such as "severity"');
        } else {
          if (seen.has(field.name)) push(`${fieldPath}.name`, `duplicate field "${field.name}"`);
          seen.add(field.name);
        }
        if (typeof field.label !== 'string' || !field.label.trim()) {
          push(`${fieldPath}.label`, 'field label is required');
        } else if (!isSafePlainText(field.label, 200)) {
          push(`${fieldPath}.label`, 'field label must be plain text');
        }
        if (field.type !== 'text' && field.type !== 'number' && field.type !== 'textarea') {
          push(`${fieldPath}.type`, 'field type must be text, number or textarea');
        }
        if (field.required !== undefined && typeof field.required !== 'boolean') {
          push(`${fieldPath}.required`, 'required must be a boolean');
        }
      });
    }
  }

  return issues;
}

export function validatePluginDraft(input: unknown, options: PluginValidationOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return [{ path: '', message: 'plugin must be an object' }];
  const push = (path: string, message: string) => issues.push({ path, message });

  if (!isWorkspaceProduct(input.product)) push('product', 'product must be "city" or "sos"');
  if (typeof input.name !== 'string' || !input.name.trim()) {
    push('name', 'name is required');
  } else if (!isSafePlainText(input.name, 160)) {
    push('name', 'name must be plain text without markup, URLs or script schemes');
  }
  if (typeof input.slug !== 'string' || !isSafeSlug(input.slug)) {
    push('slug', 'slug must be 2-64 lowercase letters, digits and hyphens');
  }
  if (input.audience !== 'admin' && input.audience !== 'member') {
    push('audience', 'audience must be "admin" or "member"');
  }

  if (!Array.isArray(input.roles)) {
    push('roles', 'roles must be an array');
  } else if (input.roles.length === 0) {
    push('roles', 'select at least one audience role');
  } else if (input.roles.length > 12) {
    push('roles', 'at most 12 roles are allowed');
  } else {
    const seen = new Set<string>();
    const allowed = (options.allowedRoles ?? []).filter(isSafeRole).map((role) => role.toLowerCase());
    input.roles.forEach((role, index) => {
      if (typeof role !== 'string' || !isSafeRole(role)) {
        push(`roles[${index}]`, 'role must be a plain role key; public/anonymous roles are rejected');
        return;
      }
      const normalized = role.toLowerCase();
      if (seen.has(normalized)) push(`roles[${index}]`, `duplicate role "${role}"`);
      seen.add(normalized);
      if (allowed.length > 0 && !allowed.includes(normalized)) {
        push(`roles[${index}]`, `role "${role}" is not advertised for this product`);
      }
    });
  }

  if (!Array.isArray(input.widgets)) {
    push('widgets', 'widgets must be an array');
  } else if (input.widgets.length > MAX_WIDGETS) {
    push('widgets', `at most ${MAX_WIDGETS} widgets are allowed`);
  } else {
    const ids = new Set<string>();
    input.widgets.forEach((widget, index) => {
      issues.push(...validateWidget(widget, index, { portable: options.portable }));
      if (isRecord(widget) && typeof widget.id === 'string') {
        if (ids.has(widget.id)) push(`widgets[${index}].id`, `duplicate widget id "${widget.id}"`);
        ids.add(widget.id);
      }
    });
  }

  return issues;
}

export function validatePluginDraftResult(input: unknown, options: PluginValidationOptions = {}): ValidationResult {
  const issues = validatePluginDraft(input, options);
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

// ---------------------------------------------------------------------------
// portable bundle validation
// ---------------------------------------------------------------------------

const BUNDLE_KEYS = new Set(['format', 'formatVersion', 'plugin', 'source', 'checksum']);
const BUNDLE_PLUGIN_KEYS = new Set(['product', 'name', 'slug', 'audience', 'roles', 'widgets']);
const BUNDLE_SOURCE_KEYS = new Set(['repository', 'path', 'revision']);
const GITHUB_REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
const CHECKSUM = /^sha256:[a-f0-9]{64}$/;

export function isAllowedSourceRepository(value: string): boolean {
  return GITHUB_REPOSITORY.test(value);
}

export function isSafeSourcePath(value: string): boolean {
  if (!value || value.length > 300) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('..')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

export type BundleParseResult = { ok: true; bundle: PluginBundle } | { ok: false; issues: ValidationIssue[] };

function validateSource(value: unknown, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return [{ path, message: 'source must be an object' }];
  for (const key of Object.keys(value)) {
    if (!BUNDLE_SOURCE_KEYS.has(key)) issues.push({ path: `${path}.${key}`, message: `"${key}" is not allowed in source` });
  }
  const repository = value.repository;
  const sourcePath = value.path;
  const revision = value.revision;
  if (typeof repository !== 'string' || !isAllowedSourceRepository(repository)) {
    issues.push({ path: `${path}.repository`, message: 'source repository must be a public https://github.com repository URL' });
  }
  if (
    typeof sourcePath !== 'string' ||
    !isSafeSourcePath(sourcePath) ||
    sourcePath.startsWith('/') ||
    sourcePath.includes('//') ||
    sourcePath.split('/').includes('..')
  ) {
    issues.push({ path: `${path}.path`, message: 'source path must be a safe relative path inside the repository' });
  }
  if (revision !== undefined && (typeof revision !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(revision))) {
    issues.push({ path: `${path}.revision`, message: 'source revision must be a short commit or tag identifier' });
  }
  return issues;
}

/**
 * Validate a portable bundle before POST /import. The original object is
 * returned unchanged so the server-side checksum remains valid.
 */
export function parsePluginBundle(input: unknown): BundleParseResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: '', message: 'bundle must be a JSON object' }] };

  for (const key of Object.keys(input)) {
    if (!BUNDLE_KEYS.has(key)) issues.push({ path: key, message: `"${key}" is not allowed in a portable plugin bundle` });
  }
  if (input.format !== PLUGIN_BUNDLE_FORMAT) {
    issues.push({ path: 'format', message: `format must be "${PLUGIN_BUNDLE_FORMAT}"` });
  }
  if (input.formatVersion !== PLUGIN_BUNDLE_VERSION) {
    issues.push({ path: 'formatVersion', message: `only formatVersion ${PLUGIN_BUNDLE_VERSION} is supported` });
  }
  if (input.checksum !== undefined && (typeof input.checksum !== 'string' || !CHECKSUM.test(input.checksum))) {
    issues.push({ path: 'checksum', message: 'checksum must look like "sha256:<64 lowercase hex>"' });
  }

  if (!isRecord(input.plugin)) {
    issues.push({ path: 'plugin', message: 'plugin must be an object' });
    return { ok: false, issues };
  }
  for (const key of Object.keys(input.plugin)) {
    if (!BUNDLE_PLUGIN_KEYS.has(key)) {
      issues.push({
        path: `plugin.${key}`,
        message: `"${key}" is server state and must not appear in an import bundle`,
      });
    }
  }
  issues.push(...validatePluginDraft(input.plugin, { portable: true }));
  if (input.source !== undefined && input.source !== null) issues.push(...validateSource(input.source, 'source'));

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, bundle: input as unknown as PluginBundle };
}

// ---------------------------------------------------------------------------
// catalog helpers
// ---------------------------------------------------------------------------

function parseWidgetTypeList(value: unknown): WorkspaceWidgetType[] {
  if (!Array.isArray(value)) return [...SAFE_WIDGET_TYPES];
  const types = value.filter(isWorkspaceWidgetType);
  const safe = SAFE_WIDGET_TYPES.filter((type) => types.includes(type));
  return safe.length > 0 ? safe : [...SAFE_WIDGET_TYPES];
}

function parseFormActionList(value: unknown): WorkspaceFormAction[] {
  if (!Array.isArray(value)) return [...FORM_ACTIONS];
  const actions = value.filter(isFormAction);
  const safe = FORM_ACTIONS.filter((action) => actions.includes(action));
  return safe.length > 0 ? safe : [...FORM_ACTIONS];
}

export function parseWorkspaceOrgReadiness(value: unknown): WorkspaceOrgReadiness {
  if (!isRecord(value)) throw new Error('The organization workflow readiness payload is invalid.');
  if (typeof value.ready !== 'boolean' || typeof value.configured !== 'boolean' || typeof value.verified !== 'boolean') {
    throw new Error('The organization workflow readiness payload is missing readiness flags.');
  }
  if (typeof value.requirement !== 'string') {
    throw new Error('The organization workflow readiness payload is missing a requirement.');
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    throw new Error('The organization workflow readiness payload has an invalid reason.');
  }
  return {
    ready: value.ready,
    configured: value.configured,
    verified: value.verified,
    requirement: value.requirement,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  };
}

function parseResource(value: unknown): CatalogResource | null {
  if (!isRecord(value) || typeof value.key !== 'string' || !isSafeResourceKey(value.key)) return null;
  return {
    key: value.key,
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
    ...(typeof value.dataset === 'string' ? { dataset: value.dataset } : {}),
  };
}

function parseCatalogProduct(value: unknown): CatalogProduct {
  if (!isRecord(value) || !isWorkspaceProduct(value.product)) {
    throw new Error('The workspace catalog returned an unknown product.');
  }
  if (!Array.isArray(value.roles)) throw new Error('The workspace catalog product is missing roles.');
  if (!Array.isArray(value.resources)) throw new Error('The workspace catalog product is missing resources.');
  const resources = value.resources.map((item) => {
    const resource = parseResource(item);
    if (!resource) throw new Error('The workspace catalog returned an invalid resource.');
    return resource;
  });
  return {
    product: value.product,
    roles: uniqueStrings(value.roles, isSafeRole),
    publicRoles: uniqueStrings(value.publicRoles),
    resources,
    widgetTypes: parseWidgetTypeList(value.widgetTypes),
    actionTypes: parseFormActionList(value.actionTypes),
  };
}

function numberField(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function parseWorkflowExecutionReadiness(value: unknown): WorkflowExecutionReadiness {
  if (!isRecord(value)) throw new Error('The workflow execution readiness payload is invalid.');
  if (typeof value.ready !== 'boolean' || typeof value.canSubmit !== 'boolean') {
    throw new Error('The workflow execution readiness payload is missing readiness flags.');
  }
  if (value.installedVersion !== null && typeof value.installedVersion !== 'string') {
    throw new Error('The workflow execution readiness payload has an invalid installedVersion.');
  }
  if (typeof value.minimumVersion !== 'string' || typeof value.requirement !== 'string') {
    throw new Error('The workflow execution readiness payload is missing version requirements.');
  }
  return {
    ready: value.ready,
    canSubmit: value.canSubmit,
    installedVersion: value.installedVersion,
    minimumVersion: value.minimumVersion,
    requirement: value.requirement,
  };
}

export function parseWorkflowReadiness(payload: unknown): WorkflowReadiness {
  if (!isRecord(payload)) throw new Error('The workflow readiness response is invalid.');
  if (typeof payload.pluginFormsCanSubmit !== 'boolean') {
    throw new Error('The workflow readiness response is missing pluginFormsCanSubmit.');
  }
  return {
    workflowExecution: parseWorkflowExecutionReadiness(payload.workflowExecution),
    pluginFormsCanSubmit: payload.pluginFormsCanSubmit,
    ...(typeof payload.directManagementExecute === 'boolean'
      ? { directManagementExecute: payload.directManagementExecute }
      : {}),
  };
}

export function parseWorkspaceCatalog(payload: unknown): WorkspaceCatalog {
  if (!isRecord(payload)) throw new Error('The workspace catalog is not an object.');
  if (!Array.isArray(payload.products)) throw new Error('The workspace catalog is missing products.');
  const products = payload.products.map(parseCatalogProduct);
  if (products.length === 0) throw new Error('The workspace catalog has no products.');
  const mutation = isRecord(payload.mutation) ? payload.mutation : {};
  const limits = isRecord(payload.limits) ? payload.limits : {};
  return {
    products,
    widgetTypes: parseWidgetTypeList(payload.widgetTypes),
    actionTypes: parseFormActionList(payload.actionTypes),
    audiences: Array.isArray(payload.audiences)
      ? payload.audiences.filter((item): item is WorkspaceAudience => item === 'admin' || item === 'member')
      : ['admin', 'member'],
    mutation: {
      formExecution: mutation.formExecution === true,
      formRequiresWorkflowArtifact: mutation.formRequiresWorkflowArtifact === true,
      directDatasetWrites: mutation.directDatasetWrites === true,
      ...(typeof mutation.reason === 'string' ? { reason: mutation.reason } : {}),
    },
    ...(payload.workflowExecution !== undefined
      ? { workflowExecution: parseWorkflowExecutionReadiness(payload.workflowExecution) }
      : {}),
    ...(payload.workflowOrgReadiness !== undefined
      ? { workflowOrgReadiness: parseWorkspaceOrgReadiness(payload.workflowOrgReadiness) }
      : {}),
    limits: {
      maxWidgets: numberField(limits.maxWidgets, MAX_WIDGETS),
      maxFields: numberField(limits.maxFields, MAX_FIELDS),
      maxColumns: numberField(limits.maxColumns, MAX_COLUMNS),
      maxTextLength: numberField(limits.maxTextLength, MAX_TEXT_LENGTH),
      maxPluginsPerOrg: numberField(limits.maxPluginsPerOrg, 100),
      ...(limits.maxRolesPerPlugin !== undefined
        ? { maxRolesPerPlugin: numberField(limits.maxRolesPerPlugin, 12) }
        : {}),
      tokenDefaultDays: numberField(limits.tokenDefaultDays, 90),
      tokenMaxDays: numberField(limits.tokenMaxDays, 365),
      widgetDataMaxRows: numberField(limits.widgetDataMaxRows, MAX_DATA_ROWS),
    },
    roles: uniqueStrings(payload.roles, isSafeRole),
  };
}

function catalogProduct(catalog: WorkspaceCatalog | null, product: WorkspaceProduct): CatalogProduct | null {
  return catalog?.products.find((item) => item.product === product) ?? null;
}

export function catalogProducts(catalog: WorkspaceCatalog | null): CatalogProduct[] {
  return catalog?.products ?? WORKSPACE_PRODUCTS.map((product) => ({
    product,
    roles: [],
    publicRoles: [],
    resources: [],
    widgetTypes: [...SAFE_WIDGET_TYPES],
    actionTypes: [...FORM_ACTIONS],
  }));
}

export function catalogRoles(catalog: WorkspaceCatalog | null, product: WorkspaceProduct): string[] {
  return catalogProduct(catalog, product)?.roles ?? [];
}

export function catalogResources(catalog: WorkspaceCatalog | null, product: WorkspaceProduct): CatalogResource[] {
  return catalogProduct(catalog, product)?.resources ?? [];
}

export function catalogWidgetTypes(catalog: WorkspaceCatalog | null, product?: WorkspaceProduct): WorkspaceWidgetType[] {
  if (product) {
    const node = catalogProduct(catalog, product);
    if (node) return node.widgetTypes;
  }
  return catalog?.widgetTypes ?? [...SAFE_WIDGET_TYPES];
}

export function catalogActionTypes(catalog: WorkspaceCatalog | null, product?: WorkspaceProduct): WorkspaceFormAction[] {
  if (product) {
    const node = catalogProduct(catalog, product);
    if (node?.actionTypes.length) return node.actionTypes;
  }
  return catalog?.actionTypes?.length ? catalog.actionTypes : [...FORM_ACTIONS];
}

export function catalogMutation(catalog: WorkspaceCatalog | null): CatalogMutation {
  return catalog?.mutation ?? {
    formExecution: false,
    formRequiresWorkflowArtifact: true,
    directDatasetWrites: false,
    reason: 'The backend has not advertised validated form execution.',
  };
}

export function catalogMembershipRoles(catalog: WorkspaceCatalog | null): string[] {
  const union = new Set<string>();
  for (const product of catalog?.products ?? []) {
    for (const role of product.roles) union.add(role);
  }
  return Array.from(union);
}

// ---------------------------------------------------------------------------
// runtime data and form helpers
// ---------------------------------------------------------------------------

function parseColumns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value, isSafeColumnName).slice(0, MAX_COLUMNS);
}

/**
 * Strict widget-data parser for the documented endpoint responses:
 * metric => `{widgetId,type:'metric',title,resource,count,generatedAt}`
 * table  => `{widgetId,type:'table',title,resource,columns,items,total,limit,offset,generatedAt}`
 * A shape mismatch is a visible error, never silently rendered as empty data.
 */
export function parseWidgetData(payload: unknown, widgetType: 'metric' | 'table'): WidgetData {
  if (!isRecord(payload)) throw new Error('The widget data response is not an object.');
  if (payload.type !== widgetType) {
    throw new Error(`The widget data response is not a ${widgetType} payload.`);
  }
  if (widgetType === 'metric') {
    const count = payload.count;
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
      throw new Error('The metric data response is missing a valid count.');
    }
    return { rows: [], total: Math.floor(count), columns: [] };
  }

  if (!Array.isArray(payload.items)) throw new Error('The table data response is missing items.');
  const rows: Array<Record<string, unknown>> = [];
  for (const item of payload.items.slice(0, MAX_DATA_ROWS)) {
    if (!isRecord(item)) throw new Error('The table data response contains a non-object row.');
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      row[key] = value;
    }
    rows.push(row);
  }
  if (typeof payload.total !== 'number' || !Number.isFinite(payload.total) || payload.total < 0) {
    throw new Error('The table data response is missing a valid total.');
  }
  const columns = parseColumns(payload.columns);
  return {
    rows,
    total: Math.floor(payload.total),
    columns: columns.length > 0 ? columns : rows[0] ? Object.keys(rows[0]).slice(0, 20) : [],
  };
}

/** Render any JSON value as inert text. Never returns HTML. */
export function safeCellText(value: unknown, max = 500): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return '—';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  } catch {
    return '—';
  }
}

/**
 * Backend authorization is authoritative: only `canSubmit` enables a form.
 * A bound same-organization workflow artifact is required for the execute call.
 */
export function isFormWritable(widget: RuntimeWidget): boolean {
  return (
    widget.canSubmit === true &&
    typeof widget.workflowArtifactId === 'string' &&
    isSafeWorkflowArtifactId(widget.workflowArtifactId)
  );
}

export function formDisabledReason(widget: RuntimeWidget): string | null {
  if (widget.type !== 'form') return null;
  if (widget.canSubmit === true && !widget.workflowArtifactId) {
    return 'This form has no bound workflow artifact. Select one in the builder; unbound forms stay read-only.';
  }
  if (!widget.canSubmit) {
    return 'This form is read-only because the backend has not authorized a validated submit action for your role (it may be unbound, inactive, or the bound workflow changed).';
  }
  return isFormWritable(widget) ? null : 'This form is not executable.';
}

const FORM_REASON_MESSAGES: Record<string, string> = {
  workflow_technical_identity_missing:
    'This organization has no verified technical workflow identity. Configure an account-level SYNAPSEDX_WORKFLOW_API_KEYS entry for the organization before enabling form actions.',
  workflow_org_identity_unverified:
    'The organization workflow technical identity could not be verified by the workflow capability.',
  workflow_sdk_release_required:
    'The published @synapseone/sdk does not yet support pinned workflow execution.',
  workflow_artifact_unbound:
    'This form is not bound to a workflow artifact, so it stays read-only.',
  workflow_artifact_missing:
    'The bound workflow artifact no longer exists for this organization.',
  workflow_artifact_not_protected:
    'The bound workflow artifact is not approved for plugin execution.',
  workflow_artifact_unpinned:
    'This published layout predates artifact pinning; republish it from the builder.',
  workflow_artifact_revision_mismatch:
    'The bound workflow changed after this layout was published; republish the layout.',
  installation_role_missing:
    'The installation has no effective role for this form.',
  runtime_token_read_only:
    'Runtime tokens can read layouts but cannot submit form actions.',
  no_form_widgets:
    'No workflow-bound form is installed for this organization.',
};

/** Map the backend reason code to a human explanation while keeping the code. */
export function formReasonMessage(reason: string | undefined | null, fallbackRequirement?: string | null): string | null {
  if (!reason) return fallbackRequirement ?? null;
  if (reason === 'ready') return null;
  if (reason === 'workflow_sdk_release_required' && fallbackRequirement) {
    return `${fallbackRequirement} (${reason})`;
  }
  const message = FORM_REASON_MESSAGES[reason] ?? 'This form is read-only.';
  return `${message} (${reason})`;
}

export function installedWidgetDataPath(installedId: string, widgetId: string): string {
  return `${WORKSPACE_API_BASE}/installed/${encodeURIComponent(installedId)}/widgets/${encodeURIComponent(widgetId)}/data`;
}

/** The only form write path: authorized same-org workflow delegation. */
export function installedWidgetExecutePath(installedId: string, widgetId: string): string {
  return `${WORKSPACE_API_BASE}/installed/${encodeURIComponent(installedId)}/widgets/${encodeURIComponent(widgetId)}/execute`;
}

export function exportBundleFileName(
  plugin: Pick<WorkspacePlugin, 'product' | 'slug' | 'version' | 'publishedVersion'>,
): string {
  const version = plugin.publishedVersion ?? plugin.version;
  return `${plugin.product}-${plugin.slug}-v${version}.synapsedx-plugin.json`;
}

export function nextWidgetId(type: WorkspaceWidgetType, existing: string[]): string {
  let index = existing.length + 1;
  let id = `${type}-${index}`;
  const used = new Set(existing);
  while (used.has(id)) {
    index += 1;
    id = `${type}-${index}`;
  }
  return id;
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Strip server-only widget fields before writing a draft back to the API. */
export function toWriteWidget(widget: WorkspaceWidget): WorkspaceWidget {
  return {
    id: widget.id,
    type: widget.type,
    title: widget.title,
    ...(widget.text !== undefined ? { text: widget.text } : {}),
    ...(widget.resource !== undefined ? { resource: widget.resource } : {}),
    ...(widget.columns !== undefined ? { columns: [...widget.columns] } : {}),
    ...(widget.fields !== undefined
      ? { fields: widget.fields.map((field) => ({ ...field })) }
      : {}),
    ...(widget.action !== undefined ? { action: widget.action } : {}),
    ...(widget.workflowArtifactId !== undefined
      ? { workflowArtifactId: widget.workflowArtifactId }
      : {}),
    ...(widget.width !== undefined ? { width: widget.width } : {}),
  };
}

// ---------------------------------------------------------------------------
// strict API response parsing
// ---------------------------------------------------------------------------

function requireString(node: Record<string, unknown>, key: string): string {
  const value = node[key];
  if (typeof value !== 'string' || !value) throw new Error(`The capability service returned an invalid "${key}".`);
  return value;
}

function optionalString(node: Record<string, unknown>, key: string): string | undefined {
  const value = node[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`The capability service returned an invalid "${key}".`);
  return value;
}

function requireVersion(node: Record<string, unknown>, key: string): number {
  const value = node[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`The capability service returned an invalid "${key}".`);
  }
  return Math.floor(value);
}

function parseWidget(input: unknown): RuntimeWidget {
  if (!isRecord(input) || !isWorkspaceWidgetType(input.type)) {
    throw new Error('The capability service returned an unsupported widget type.');
  }
  const type = input.type;
  const widget: RuntimeWidget = {
    id: requireString(input, 'id'),
    type,
    title: requireString(input, 'title'),
  };
  if (!isSafeWidgetId(widget.id)) throw new Error('The capability service returned an invalid widget id.');
  if (input.width !== undefined) {
    if (input.width !== 'full' && input.width !== 'half') {
      throw new Error('The capability service returned an invalid widget width.');
    }
    widget.width = input.width;
  }
  if (type === 'text') {
    widget.text = optionalString(input, 'text') ?? '';
  } else {
    widget.resource = requireString(input, 'resource');
    if (!isSafeResourceKey(widget.resource)) throw new Error('The capability service returned an invalid resource key.');
  }
  if (type === 'table') {
    if (!Array.isArray(input.columns) || input.columns.length === 0) {
      throw new Error('The capability service returned a table without columns.');
    }
    widget.columns = parseColumns(input.columns);
    if (widget.columns.length === 0) throw new Error('The capability service returned invalid table columns.');
  }
  if (type === 'form') {
    if (!Array.isArray(input.fields)) throw new Error('The capability service returned a form without fields.');
    const action = input.action === undefined ? 'create' : input.action;
    if (!isFormAction(action)) throw new Error('The capability service returned an invalid form action.');
    widget.action = action;
    widget.fields = input.fields.map((field) => {
      if (
        !isRecord(field) ||
        typeof field.name !== 'string' ||
        !isSafeFieldName(field.name) ||
        typeof field.label !== 'string' ||
        (field.type !== 'text' && field.type !== 'number' && field.type !== 'textarea')
      ) {
        throw new Error('The capability service returned an invalid form field.');
      }
      return {
        name: field.name,
        label: field.label,
        type: field.type,
        ...(field.required === true ? { required: true } : {}),
      };
    });
    if (input.workflowArtifactId !== undefined) {
      if (typeof input.workflowArtifactId !== 'string' || !isSafeWorkflowArtifactId(input.workflowArtifactId)) {
        throw new Error('The capability service returned an invalid workflowArtifactId.');
      }
      widget.workflowArtifactId = input.workflowArtifactId;
    }
    if (input.workflowArtifactRevision !== undefined) {
      if (
        typeof input.workflowArtifactRevision !== 'number' ||
        !Number.isFinite(input.workflowArtifactRevision) ||
        input.workflowArtifactRevision < 0
      ) {
        throw new Error('The capability service returned an invalid workflowArtifactRevision.');
      }
      widget.workflowArtifactRevision = Math.floor(input.workflowArtifactRevision);
    }
    if (input.workflowArtifactChecksum !== undefined) {
      if (typeof input.workflowArtifactChecksum !== 'string') {
        throw new Error('The capability service returned an invalid workflowArtifactChecksum.');
      }
      widget.workflowArtifactChecksum = input.workflowArtifactChecksum;
    }
    if (input.canSubmit !== undefined) {
      if (typeof input.canSubmit !== 'boolean') {
        throw new Error('The capability service returned an invalid canSubmit.');
      }
      widget.canSubmit = input.canSubmit;
    }
    if (input.canSubmitReason !== undefined && input.canSubmitReason !== null) {
      if (typeof input.canSubmitReason !== 'string') {
        throw new Error('The capability service returned an invalid canSubmitReason.');
      }
      widget.canSubmitReason = input.canSubmitReason;
    }
  }
  return widget;
}

function parseInstalledRoles(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('The capability service returned invalid installedRoles.');
  return uniqueStrings(value, isSafeRole);
}

export function parsePlugin(payload: unknown): WorkspacePlugin {
  if (!isRecord(payload)) throw new Error('The capability service returned an invalid plugin.');
  if (!isWorkspaceProduct(payload.product)) throw new Error('The capability service returned an invalid product.');
  if (payload.audience !== 'admin' && payload.audience !== 'member') {
    throw new Error('The capability service returned an invalid audience.');
  }
  if (payload.status !== 'draft' && payload.status !== 'published') {
    throw new Error('The capability service returned an invalid plugin status.');
  }
  if (typeof payload.installed !== 'boolean') {
    throw new Error('The capability service returned a plugin without installation metadata.');
  }
  if (!Array.isArray(payload.widgets)) throw new Error('The capability service returned a plugin without widgets.');
  const plugin: WorkspacePlugin = {
    id: requireString(payload, 'id'),
    product: payload.product,
    name: requireString(payload, 'name'),
    slug: requireString(payload, 'slug'),
    audience: payload.audience,
    roles: uniqueStrings(payload.roles, isSafeRole),
    widgets: payload.widgets.map(parseWidget),
    status: payload.status,
    version: requireVersion(payload, 'version'),
    createdAt: requireString(payload, 'createdAt'),
    updatedAt: requireString(payload, 'updatedAt'),
    installed: payload.installed,
  };
  if (payload.publishedVersion !== undefined) plugin.publishedVersion = requireVersion(payload, 'publishedVersion');
  if (payload.publishedAt !== undefined) plugin.publishedAt = optionalString(payload, 'publishedAt');
  const installedRoles = parseInstalledRoles(payload.installedRoles);
  if (installedRoles) plugin.installedRoles = installedRoles;
  return plugin;
}

export function parsePluginList(payload: unknown): WorkspacePlugin[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error('The capability service returned an invalid plugin list.');
  }
  return payload.items.map(parsePlugin);
}

export function parseInstalledPlugin(payload: unknown): InstalledPlugin {
  if (!isRecord(payload)) throw new Error('The capability service returned an invalid installed plugin.');
  if (!isWorkspaceProduct(payload.product)) throw new Error('The capability service returned an invalid product.');
  if (payload.audience !== 'admin' && payload.audience !== 'member') {
    throw new Error('The capability service returned an invalid audience.');
  }
  if (!Array.isArray(payload.widgets)) throw new Error('The installed plugin has no widgets.');
  return {
    id: requireString(payload, 'id'),
    product: payload.product,
    name: requireString(payload, 'name'),
    slug: requireString(payload, 'slug'),
    audience: payload.audience,
    roles: uniqueStrings(payload.roles, isSafeRole),
    widgets: payload.widgets.map(parseWidget),
    version: requireVersion(payload, 'version'),
    publishedVersion: requireVersion(payload, 'publishedVersion'),
    publishedAt: requireString(payload, 'publishedAt'),
    checksum: requireString(payload, 'checksum'),
    ...(typeof payload.installedAt === 'string' ? { installedAt: payload.installedAt } : {}),
    ...(payload.installationRoles !== undefined
      ? { installationRoles: uniqueStrings(payload.installationRoles, isSafeRole) }
      : {}),
  };
}

export function parseInstalledList(payload: unknown): InstalledPlugin[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error('The capability service returned an invalid installed list.');
  }
  return payload.items.map(parseInstalledPlugin);
}

export function parseMembers(payload: unknown): WorkspaceMember[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error('The capability service returned an invalid member list.');
  }
  return payload.items.map((item) => {
    if (!isRecord(item) || typeof item.subject !== 'string' || !item.subject) {
      throw new Error('The capability service returned an invalid member.');
    }
    if (!Array.isArray(item.roles)) throw new Error('The capability service returned a member without roles.');
    return {
      subject: item.subject,
      roles: uniqueStrings(item.roles, isSafeRole),
      ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
      ...(typeof item.updatedBy === 'string' ? { updatedBy: item.updatedBy } : {}),
    };
  });
}

export function parseTokens(payload: unknown): WorkspaceTokenMetadata[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error('The capability service returned an invalid token list.');
  }
  return payload.items.map((item) => {
    if (!isRecord(item) || !isWorkspaceProduct(item.product)) {
      throw new Error('The capability service returned an invalid token.');
    }
    return {
      id: requireString(item, 'id'),
      product: item.product,
      name: requireString(item, 'name'),
      tokenPrefix: requireString(item, 'tokenPrefix'),
      createdAt: requireString(item, 'createdAt'),
      expiresAt: requireString(item, 'expiresAt'),
      ...(typeof item.revokedAt === 'string' ? { revokedAt: item.revokedAt } : {}),
      ...(typeof item.lastUsedAt === 'string' ? { lastUsedAt: item.lastUsedAt } : {}),
    };
  });
}

export function parseWorkflowArtifacts(payload: unknown): WorkflowArtifactSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error('The workflow artifact list is invalid.');
  }
  return payload.items.map((item) => {
    if (!isRecord(item)) throw new Error('The workflow artifact list contains an invalid item.');
    const syncState = item.syncState;
    return {
      id: requireString(item, 'id'),
      name: requireString(item, 'name'),
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      ...(typeof item.slug === 'string' ? { slug: item.slug } : {}),
      active: item.active === true,
      revision: typeof item.revision === 'number' && Number.isFinite(item.revision) ? Math.floor(item.revision) : 0,
      nodeCount: typeof item.nodeCount === 'number' && Number.isFinite(item.nodeCount) ? Math.floor(item.nodeCount) : 0,
      ...(syncState === 'ready' || syncState === 'pending' || syncState === 'failed'
        ? { syncState }
        : {}),
      ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
    };
  });
}

export function tokenStatus(token: WorkspaceTokenMetadata): 'revoked' | 'expired' | 'active' {
  if (token.revokedAt) return 'revoked';
  const time = new Date(token.expiresAt).getTime();
  if (Number.isFinite(time) && time <= Date.now()) return 'expired';
  return 'active';
}
