// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Tier-2 workflow exported-code management.
 *
 * Saved artifacts live in Tier-1 SynapseBase through the published
 * `@synapseone/sdk` Base API. Workflow creation, update, export and execution
 * are delegated exclusively to the Tier-1 Workflow SDK with the caller's own
 * verified credential, so Tier-1 enforces its own tenant boundaries.
 *
 * Security invariants:
 * - No Tier-2 database, queue, cache or filesystem store is added.
 * - Imported definitions are JSON data only. This module never evaluates code
 *   (`eval`, `Function`, `vm`, child_process or shell are not used).
 * - Definitions are structurally validated (plain JSON, bounded size, unique
 *   node names, no prototype-pollution keys, no private/internal URLs).
 * - Credential secret material is recursively scrubbed before anything is
 *   persisted, forwarded to Tier-1 or exported. Only redaction paths remain.
 * - Tenants are derived from the verified principal; cross-tenant reads and
 *   mutations return 404 without leaking existence.
 */
import { Express } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { SynapseOneClient, SynapseOneError } from '@synapseone/sdk';
import { Caller, credentialClient, isAdmin } from '../auth';
import { ServiceConfig, isPrivateHost } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { parsePagination, setPageHeaders } from '../pagination';
import {
  queryDocuments, recordAudit, correlationIdOf, getDocumentOrNull, isNotFound, serviceClient, StoredDocument,
} from '../platform';
import { authenticatedReadContext, expectedVersion, writeContext } from './shared';

/** Tier-1 Base collections owned by this capability (no schema migration). */
const ARTIFACT_COLLECTION = 'synapsedx_capability_workflow_artifacts';
const VERSION_COLLECTION = 'synapsedx_capability_workflow_artifact_versions';

const FORMAT = 'synapsedx-workflow-artifact';
const FORMAT_VERSION = 1;
/** First published @synapseone/sdk release with execute expectedRevision. */
const MIN_REVISION_SDK_VERSION = '0.9.1';
/** Portable reference for the per-organization DX capability API key. */
const ORG_CREDENTIAL_REF = 'synapsedx-organization';
const ORG_CREDENTIAL_HEADER = 'X-API-Key';

interface CredentialBinding {
  name: string;
  credentialId: string;
  owner: string;
  header: string;
}
const MAX_DEFINITION_BYTES = 200 * 1024;
const MAX_EXECUTE_BYTES = 200 * 1024;
const MAX_NODES = 50;
const MAX_NODE_CODE_BYTES = 50 * 1024;
const MAX_SETTINGS_BYTES = 8 * 1024;
const MAX_NAME = 160;
const MAX_DESCRIPTION = 600;
const ID_RE = /^[A-Za-z0-9_-]{8,120}$/;
const WORKFLOW_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Node types that execute local commands or read local files are rejected at
 * the DX boundary. Tier-1 owns execution; DX never runs workflow code.
 */
const UNSAFE_NODE_TYPES = new Set([
  'n8n-nodes-base.executecommand',
  'n8n-nodes-base.ssh',
  'n8n-nodes-base.localfiletrigger',
  'n8n-nodes-base.readlocalfile',
  'n8n-nodes-base.writelocalfile',
]);

export interface WorkflowArtifactSource {
  kind: 'bundle' | 'tier1-workflow' | 'definition';
  repository?: string;
  path?: string;
  revision?: string;
}

export interface WorkflowArtifactRecord {
  id: string;
  tenant: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  description?: string;
  slug?: string;
  format: typeof FORMAT;
  formatVersion: typeof FORMAT_VERSION;
  /** DX artifact revision, incremented by every graph update. */
  revision: number;
  /** Tier-1 workflow id (never exported). */
  workflowId: string;
  /** Tier-1 revision reported by the SDK, when available. */
  workflowRevision?: number;
  active: boolean;
  nodes: Array<Record<string, unknown>>;
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
  source: WorkflowArtifactSource;
  /** Who owns the Tier-1 workflow: technical org identity or the importing user. */
  managedBy?: 'technical' | 'user';
  /** Tier-1 workflow access mode recorded in `settings.access.mode`. */
  accessMode?: 'owner-only' | 'legacy' | 'unsupported';
  /** True only when `settings.access.mode === 'owner-only'`. */
  protected?: boolean;
  /** SHA-256 of the deployed canonical graph (includes credential ids). */
  checksum: string;
  /** SHA-256 of the portable ref graph (no environment-local credential ids). */
  portableChecksum?: string;
  /** Internal environment bindings; never exported. */
  credentialBindings?: CredentialBinding[];
  /** Redaction paths (never values) applied to the saved graph. */
  credentialRedactions: string[];
  versionCount: number;
  /**
   * Two-phase update marker. `pending` means DX acquired the Base CAS guard
   * before mutating Tier-1 and has not finalized yet; `failed` means the
   * Tier-1 mutation and its compensation both failed and an admin must
   * reconcile. Missing (legacy) or `ready` means the snapshot is usable.
   */
  syncState?: 'ready' | 'pending' | 'failed';
  syncError?: string;
  pendingRevision?: number;
  pendingChecksum?: string;
  pendingUpdatedAt?: string;
  /**
   * Revision-history durability. `pending`/`incomplete` is visible to callers
   * and `POST /:id/reconcile` retries the snapshot; never silently claim the
   * history is complete when the Base write failed.
   */
  versionHistoryStatus?: 'pending' | 'complete' | 'incomplete';
  versionHistoryError?: string;
  lastExecutedAt?: string;
  lastExecutionId?: string;
}

export interface WorkflowArtifactVersionRecord {
  id: string;
  artifactId: string;
  tenant: string;
  revision: number;
  workflowRevision?: number;
  checksum: string;
  createdBy: string;
  createdAt: string;
  nodes: Array<Record<string, unknown>>;
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
  credentialRedactions: string[];
}

interface Definition {
  nodes: Array<Record<string, unknown>>;
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
}

interface ScrubResult {
  definition: Definition;
  redactions: string[];
}

/* ------------------------------------------------------------------------- *
 * JSON safety, canonicalization and validation
 * ------------------------------------------------------------------------- */

function badDocument(message: string): never {
  throw apiError(400, 'invalid_document', message);
}

function jsonClone(value: unknown, label: string, maxBytes: number): any {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    badDocument(`${label} must be JSON-serializable`);
  }
  if (typeof encoded !== 'string') badDocument(`${label} must be JSON data`);
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw apiError(413, 'payload_too_large', `${label} exceeds ${Math.floor(maxBytes / 1024)}KB`);
  }
  try {
    return JSON.parse(encoded);
  } catch {
    badDocument(`${label} must be JSON data`);
  }
}

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function assertNoDangerousKeys(value: unknown, path = 'document', depth = 0): void {
  if (depth > 40 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoDangerousKeys(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) badDocument(`${path} contains the reserved key ${key}`);
    assertNoDangerousKeys(entry, `${path}.${key}`, depth + 1);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

export function workflowGraphChecksum(definition: Pick<Definition, 'nodes' | 'connections' | 'settings'>): string {
  return createHash('sha256')
    .update(canonicalJson({ nodes: definition.nodes, connections: definition.connections, settings: definition.settings || {} }))
    .digest('hex');
}

function optionalString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.length > max) throw apiError(400, 'invalid_document', `${name} must be ≤${max} characters`);
  return text;
}

function requiredName(value: unknown, fallback = ''): string {
  const text = String(value ?? fallback).trim();
  if (!text || text.length > MAX_NAME) {
    throw apiError(400, 'invalid_document', `name must be 1..${MAX_NAME} characters`);
  }
  return text;
}

/** Reject URL literals that point at localhost, private ranges or containers. */
export function findBlockedWorkflowUrl(value: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (entry: unknown, depth: number): string | null => {
    if (depth > 12 || entry === null || entry === undefined) return null;
    if (typeof entry === 'string') {
      if (entry.length > 2048) return null;
      if (/^file:\/\//i.test(entry)) return entry;
      if (!/^https?:\/\//i.test(entry)) return null;
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        return entry;
      }
      const host = url.hostname.trim().toLowerCase();
      if (
        isPrivateHost(host)
        || host.endsWith('.internal')
        || host.endsWith('.local')
        || host.endsWith('.localhost')
        || host === 'host.docker.internal'
        || host === 'gateway.docker.internal'
        || (!host.includes('.') && !/^\d+$/.test(host))
      ) {
        return entry;
      }
      return null;
    }
    if (typeof entry !== 'object' || seen.has(entry)) return null;
    seen.add(entry);
    const values = Array.isArray(entry) ? entry : Object.values(entry as Record<string, unknown>);
    for (const child of values) {
      const hit = walk(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(value, 0);
}

function validateNode(node: unknown, index: number, names: Set<string>): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    badDocument(`nodes[${index}] must be an object`);
  }
  const record = node as Record<string, unknown>;
  const name = String(record.name ?? '').trim();
  if (!name || name.length > 128) badDocument(`nodes[${index}].name must be 1..128 characters`);
  if (names.has(name)) badDocument(`duplicate node name '${name}'`);
  names.add(name);
  const type = String(record.type ?? '').trim();
  if (!type || type.length > 128) badDocument(`nodes['${name}'].type must be 1..128 characters`);
  if (UNSAFE_NODE_TYPES.has(type.toLowerCase())) {
    throw apiError(400, 'invalid_document', `nodes['${name}'] uses a local-execution node type that DX does not allow`);
  }
  if (record.parameters !== undefined) {
    if (!record.parameters || typeof record.parameters !== 'object' || Array.isArray(record.parameters)) {
      badDocument(`nodes['${name}'].parameters must be an object`);
    }
    const code = (record.parameters as Record<string, unknown>).code
      ?? (record.parameters as Record<string, unknown>).jsCode;
    if (typeof code === 'string' && Buffer.byteLength(code, 'utf8') > MAX_NODE_CODE_BYTES) {
      throw apiError(413, 'payload_too_large', `nodes['${name}'].code exceeds 50KB`);
    }
  }
  if (record.typeVersion !== undefined && (typeof record.typeVersion !== 'number' || !Number.isFinite(record.typeVersion))) {
    badDocument(`nodes['${name}'].typeVersion must be a number`);
  }
  if (record.position !== undefined) {
    if (!Array.isArray(record.position) || record.position.length !== 2 || record.position.some((item) => typeof item !== 'number')) {
      badDocument(`nodes['${name}'].position must be [x, y]`);
    }
  }
  if (record.credentials !== undefined && (!record.credentials || typeof record.credentials !== 'object' || Array.isArray(record.credentials))) {
    badDocument(`nodes['${name}'].credentials must be an object`);
  }
}

/**
 * Strict structural validation of a workflow definition (Tier-1 re-validates
 * its own contract). Import and update both use this path.
 */
export function validateWorkflowDefinition(value: unknown, options: { maxNodes?: number } = {}): Definition {
  const clone = jsonClone(value, 'definition', MAX_DEFINITION_BYTES);
  if (!clone || typeof clone !== 'object' || Array.isArray(clone)) {
    badDocument('definition must be an object with nodes and connections');
  }
  assertNoDangerousKeys(clone, 'definition');
  const raw = clone as Record<string, unknown>;
  if (!Array.isArray(raw.nodes)) badDocument('definition.nodes must be an array');
  const maxNodes = options.maxNodes ?? MAX_NODES;
  if (raw.nodes.length < 1 || raw.nodes.length > maxNodes) {
    badDocument(`definition.nodes must contain 1..${maxNodes} nodes`);
  }
  const names = new Set<string>();
  raw.nodes.forEach((node, index) => validateNode(node, index, names));

  if (raw.connections === undefined) badDocument('definition.connections must be an object');
  if (!raw.connections || typeof raw.connections !== 'object' || Array.isArray(raw.connections)) {
    badDocument('definition.connections must be an object');
  }
  let settings: Record<string, unknown> = {};
  if (raw.settings !== undefined) {
    if (!raw.settings || typeof raw.settings !== 'object' || Array.isArray(raw.settings)) {
      badDocument('definition.settings must be an object');
    }
    settings = jsonClone(raw.settings, 'definition.settings', MAX_SETTINGS_BYTES) as Record<string, unknown>;
  }
  const blocked = findBlockedWorkflowUrl({ nodes: raw.nodes, connections: raw.connections, settings });
  if (blocked) {
    throw apiError(400, 'blocked_url', 'the definition contains a private/internal URL', {
      url: scrubString(blocked).slice(0, 200),
    });
  }
  return {
    nodes: raw.nodes as Array<Record<string, unknown>>,
    connections: raw.connections as Record<string, unknown>,
    settings,
  };
}

/* ------------------------------------------------------------------------- *
 * Credential scrubbing
 * ------------------------------------------------------------------------- */

const SECRET_KEY_RE = /^(authorization|proxy-authorization|cookie|set-cookie|token|bearer|x-api-key|x-auth-token|x-signature)$/i;
const SECRET_KEY_SUFFIX_RE = /(api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|token|client[-_]?secret|secret|password|passwd|private[-_]?key|hmac|signature)$/i;
const REDACTED = '[REDACTED]';

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key) || SECRET_KEY_SUFFIX_RE.test(key);
}

/** Scrub credential material embedded in plain strings (URLs, code, headers). */
export function scrubString(value: string): string {
  let output = value;
  // URL userinfo: https://user:password@host/...
  output = output.replace(/^(https?:\/\/)[^/@\s]+@/i, `$1${REDACTED}@`);
  // Bearer credentials in code/header text.
  output = output.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`);
  // URL query credentials.
  output = output.replace(/([?&](?:api[_-]?key|access_token|refresh_token|token|key)=)[^&\s#'"]+/gi, `$1${REDACTED}`);
  // Common literal assignments in code nodes: token = "value".
  output = output.replace(
    /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)\b\s*[:=]\s*)(['"`])([^'"`\r\n]{8,})\2/gi,
    `$1$2${REDACTED}$2`,
  );
  return output;
}

function secretHeaderName(name: string): boolean {
  return isSecretKey(name.trim());
}

function scrubNode(
  value: unknown,
  path: string,
  redactions: Set<string>,
  depth = 0,
): unknown {
  if (depth > 24) return value;
  if (typeof value === 'string') {
    const scrubbed = scrubString(value);
    if (scrubbed !== value) redactions.add(path);
    return scrubbed;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => scrubNode(entry, `${path}[${index}]`, redactions, depth + 1));
  }
  const record = value as Record<string, unknown>;
  // n8n header/query parameter pairs carry the credential name in `name`.
  const namedSecret = typeof record.name === 'string' && secretHeaderName(record.name) && typeof record.value === 'string';
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isSecretKey(key)) {
      const referenceOnly = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        && Object.keys(entry as Record<string, unknown>).every((name) => ['id', 'name', 'type'].includes(name));
      if (entry !== undefined && entry !== null && entry !== '' && !referenceOnly) {
        redactions.add(childPath);
        output[key] = REDACTED;
      } else {
        output[key] = entry && typeof entry === 'object' && !Array.isArray(entry)
          ? scrubNode(entry, childPath, redactions, depth + 1)
          : entry;
      }
      continue;
    }
    if (namedSecret && key === 'value') {
      redactions.add(childPath);
      output[key] = REDACTED;
      continue;
    }
    output[key] = scrubNode(entry, childPath, redactions, depth + 1);
  }
  return output;
}

/**
 * Scrub a validated definition. The graph shape (nodes, connections,
 * parameters and code structure) is preserved; only credential values are
 * replaced with `[REDACTED]`.
 */
export function scrubWorkflowDefinition(definition: Definition): ScrubResult {
  const redactions = new Set<string>();
  const nodes = definition.nodes.map((node, index) => {
    const label = typeof node.name === 'string' && node.name ? node.name : `node-${index}`;
    return scrubNode(node, `nodes[${index}](${label})`, redactions) as Record<string, unknown>;
  });
  const connections = scrubNode(definition.connections, 'connections', redactions) as Record<string, unknown>;
  const settings = scrubNode(definition.settings || {}, 'settings', redactions) as Record<string, unknown>;
  return {
    definition: { nodes, connections, settings },
    redactions: [...redactions].sort(),
  };
}

/* ------------------------------------------------------------------------- *
 * Tier-1 owner-only access policy (root owns enforcement in workflow-service)
 * ------------------------------------------------------------------------- */

type AccessMode = 'owner-only' | 'legacy' | 'unsupported';

function accessModeOf(settings: Record<string, unknown> | undefined): AccessMode {
  if (!settings || typeof settings !== 'object') return 'legacy';
  const access = settings.access;
  if (access === undefined) return 'legacy';
  if (!access || typeof access !== 'object' || Array.isArray(access)) return 'unsupported';
  const mode = (access as Record<string, unknown>).mode;
  if (mode === undefined || mode === 'owner-only') return 'owner-only';
  return 'unsupported';
}

function assertSupportedAccess(settings: Record<string, unknown>, label: string): void {
  const access = settings.access;
  if (access !== undefined) {
    if (!access || typeof access !== 'object' || Array.isArray(access)) {
      throw apiError(409, 'unsupported_access_mode' as any, `${label}.access must be an object`, {
        accessMode: 'unsupported',
      });
    }
    const mode = (access as Record<string, unknown>).mode;
    if (mode !== undefined && mode !== 'owner-only') {
      throw apiError(409, 'unsupported_access_mode' as any, `${label}.access.mode is not supported by DX workflow management`, {
        accessMode: String(mode),
        supported: ['owner-only'],
      });
    }
  }
}

/** Preserve unrelated settings and set the Tier-1 owner-only access policy. */
function withOwnerOnly(settings: Record<string, unknown> | undefined): Record<string, unknown> {
  const base = settings && typeof settings === 'object' ? settings : {};
  const access = base.access && typeof base.access === 'object' && !Array.isArray(base.access)
    ? base.access as Record<string, unknown>
    : {};
  return { ...base, access: { ...access, mode: 'owner-only' } };
}

function protectedArtifact(settings: Record<string, unknown> | undefined): { accessMode: AccessMode; protected: boolean } {
  const accessMode = accessModeOf(settings);
  return { accessMode, protected: accessMode === 'owner-only' };
}

function assertPluginProtected(artifact: WorkflowArtifactRecord): void {
  const protection = protectedArtifact(artifact.settings);
  if (protection.protected && artifact.managedBy === 'technical') return;
  throw apiError(409, 'workflow_not_protected' as any, 'the workflow artifact is not a technical-identity owner-only workflow; clone/update it before plugin binding', {
    accessMode: protection.accessMode,
    protected: protection.protected,
    managedBy: artifact.managedBy || 'user',
    required: 'technical + owner-only',
  });
}

/* ------------------------------------------------------------------------- *
 * Portable credential references (synapsedx-organization)
 * ------------------------------------------------------------------------- */

function isHttpRequestNode(node: Record<string, unknown>): boolean {
  const type = String(node.type || '').trim().toLowerCase();
  return type === 'httprequest' || type === 'n8n-nodes-base.httprequest' || type.endsWith('.httprequest');
}

function hasCredentialNodes(nodes: Array<Record<string, unknown>> | undefined): boolean {
  for (const node of nodes || []) {
    if (!isHttpRequestNode(node)) continue;
    const parameters = node.parameters;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) continue;
    const parameterRecord = parameters as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(parameterRecord, 'credentialId')) return true;
    const authValue = parameterRecord.auth;
    if (authValue && typeof authValue === 'object' && !Array.isArray(authValue)) {
      const auth = authValue as Record<string, unknown>;
      if (auth.credentialRef || auth.credentialId) return true;
    }
  }
  return false;
}

function credentialOwnerOf(metadata: any): string | undefined {
  const owner = metadata?.owner ?? metadata?.owner_sub ?? metadata?.ownerSub;
  return typeof owner === 'string' && owner ? owner : undefined;
}

function credentialHeader(auth: Record<string, unknown>): string {
  const header = String(auth.header || '').trim();
  if (header.toLowerCase() !== ORG_CREDENTIAL_HEADER.toLowerCase()) {
    throw apiError(400, 'invalid_credential_reference' as any, `workflow auth.header must be ${ORG_CREDENTIAL_HEADER}`, {
      credentialRef: ORG_CREDENTIAL_REF,
      requiredHeader: ORG_CREDENTIAL_HEADER,
    });
  }
  return ORG_CREDENTIAL_HEADER;
}

function credentialRefOf(auth: Record<string, unknown>): string | undefined {
  if (auth.credentialRef === undefined || auth.credentialRef === null || auth.credentialRef === '') return undefined;
  return String(auth.credentialRef).trim() || undefined;
}

function credentialIdOf(auth: Record<string, unknown>): string | undefined {
  if (auth.credentialId === undefined || auth.credentialId === null || auth.credentialId === '') return undefined;
  return String(auth.credentialId).trim() || undefined;
}

async function ensureOrgCredential(
  technical: OrgWorkflowIdentity,
  cache: Map<string, CredentialBinding>,
): Promise<CredentialBinding> {
  const cached = cache.get(ORG_CREDENTIAL_REF);
  if (cached) return cached;
  const secret = readOrgWorkflowKeys()[technical.org];
  if (!secret) {
    throw apiError(503, 'dependency_unavailable', 'the organization workflow technical identity is unavailable', {
      org: technical.org,
      dependency: 'synapseone-workflow',
      technicalIdentity: false,
      canSubmit: false,
    });
  }
  const expectedOwner = `apikey:${technical.accountId}`;
  const existing = async () => {
    const credentials = await technical.client.workflow.listCredentials(technical.accountId);
    const list = Array.isArray(credentials) ? credentials : [];
    return list.find((credential: any) => String(credential?.name || '') === ORG_CREDENTIAL_REF) as any;
  };
  let metadata = await existing();
  if (metadata) {
    const owner = credentialOwnerOf(metadata);
    if (owner !== expectedOwner) {
      throw apiError(409, 'credential_owner_mismatch' as any, 'the organization workflow credential is not owned by the verified technical account', {
        credentialName: ORG_CREDENTIAL_REF,
        expectedOwner,
        actualOwner: owner || null,
      });
    }
    // Keep the id stable but ensure the credential uses the current env key.
    try {
      metadata = await technical.client.workflow.rotateCredential(String(metadata.id), secret);
    } catch {
      throw apiError(503, 'dependency_unavailable', 'the organization workflow credential could not be rotated to the current key', {
        dependency: 'synapseone-workflow',
        credentialName: ORG_CREDENTIAL_REF,
      });
    }
  } else {
    try {
      metadata = await technical.client.workflow.createCredential({
        accountId: technical.accountId,
        name: ORG_CREDENTIAL_REF,
        kind: 'api-key',
        secret,
      });
    } catch (error) {
      // A concurrent import may have created it; re-read once.
      metadata = await existing();
      if (!metadata) throw error;
      if (credentialOwnerOf(metadata) !== expectedOwner) {
        throw apiError(409, 'credential_owner_mismatch' as any, 'the existing organization workflow credential has an unexpected owner', {
          credentialName: ORG_CREDENTIAL_REF,
          expectedOwner,
          actualOwner: credentialOwnerOf(metadata) || null,
        });
      }
    }
  }
  const owner = credentialOwnerOf(metadata);
  if (owner !== expectedOwner) {
    throw apiError(409, 'credential_owner_mismatch' as any, 'the organization workflow credential is not owned by the verified technical account', {
      credentialName: ORG_CREDENTIAL_REF,
      expectedOwner,
      actualOwner: owner || null,
    });
  }
  const binding: CredentialBinding = {
    name: ORG_CREDENTIAL_REF,
    credentialId: String(metadata.id),
    owner: expectedOwner,
    header: ORG_CREDENTIAL_HEADER,
  };
  cache.set(ORG_CREDENTIAL_REF, binding);
  return binding;
}

async function resolveExistingCredential(
  technical: OrgWorkflowIdentity,
  credentialId: string,
  cache: Map<string, CredentialBinding>,
): Promise<CredentialBinding> {
  const cached = cache.get(credentialId);
  if (cached) return cached;
  let metadata: any;
  try {
    metadata = await technical.client.workflow.getCredential(credentialId);
  } catch {
    throw apiError(409, 'credential_owner_mismatch' as any, 'the workflow references a credential that cannot be resolved by the technical owner', {
      credentialId,
    });
  }
  const expectedOwner = `apikey:${technical.accountId}`;
  const owner = credentialOwnerOf(metadata);
  if (owner !== expectedOwner || String(metadata?.name || '') !== ORG_CREDENTIAL_REF) {
    throw apiError(409, 'credential_owner_mismatch' as any, 'legacy workflow credentials are not reusable by the technical owner; rebind auth.credentialRef', {
      credentialId,
      credentialName: metadata?.name || null,
      expectedOwner,
      actualOwner: owner || null,
      requiredRef: ORG_CREDENTIAL_REF,
    });
  }
  const binding: CredentialBinding = {
    name: ORG_CREDENTIAL_REF,
    credentialId,
    owner,
    header: ORG_CREDENTIAL_HEADER,
  };
  cache.set(credentialId, binding);
  return binding;
}

async function bindWorkflowCredentials(
  technical: OrgWorkflowIdentity,
  definition: Definition,
  options: { allowExistingIds: boolean; publicOrigin: string },
): Promise<{ definition: Definition; bindings: CredentialBinding[] }> {
  const cache = new Map<string, CredentialBinding>();
  const bindings = new Map<string, CredentialBinding>();
  let hasCredential = false;
  // Reject engine credential aliases that bypass the auth object, and unknown
  // auth keys that could hide a second reference.
  for (const raw of definition.nodes) {
    if (!isHttpRequestNode(raw) || !raw.parameters || typeof raw.parameters !== 'object' || Array.isArray(raw.parameters)) continue;
    const parameters = raw.parameters as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(parameters, 'credentialId')) {
      throw apiError(400, 'invalid_credential_reference' as any, 'top-level parameters.credentialId is not supported; use auth.credentialRef', {
        requiredRef: ORG_CREDENTIAL_REF,
      });
    }
    const authValue = parameters.auth;
    if (authValue === undefined) continue;
    if (!authValue || typeof authValue !== 'object' || Array.isArray(authValue)) {
      throw apiError(400, 'invalid_credential_reference' as any, 'workflow auth must be an object');
    }
    const auth = authValue as Record<string, unknown>;
    const ref = credentialRefOf(auth);
    const id = credentialIdOf(auth);
    if (!ref && !id) {
      throw apiError(400, 'invalid_credential_reference' as any, 'workflow auth must contain credentialRef or credentialId', {
        supported: [ORG_CREDENTIAL_REF],
      });
    }
    const allowedKeys = ref
      ? new Set(['credentialRef', 'header', 'allowedOrigins'])
      : new Set(['credentialId', 'header', 'allowedOrigins']);
    const unknown = Object.keys(auth).find((key) => !allowedKeys.has(key));
    if (unknown) {
      throw apiError(400, 'invalid_credential_reference' as any, `unsupported workflow auth key '${unknown}'`, {
        authKeys: Object.keys(auth),
        allowedAuthKeys: [...allowedKeys],
      });
    }
    hasCredential = true;
  }
  if (hasCredential) await requireCredentialDestinationProtection(technical);
  const nodes = await Promise.all(definition.nodes.map(async (raw) => {
    if (!isHttpRequestNode(raw) || !raw.parameters || typeof raw.parameters !== 'object' || Array.isArray(raw.parameters)) {
      return raw;
    }
    const parameters = { ...(raw.parameters as Record<string, unknown>) };
    const authValue = parameters.auth;
    if (authValue === undefined) return raw;
    if (!authValue || typeof authValue !== 'object' || Array.isArray(authValue)) {
      throw apiError(400, 'invalid_credential_reference' as any, 'workflow auth must be an object');
    }
    const auth = { ...(authValue as Record<string, unknown>) };
    const ref = credentialRefOf(auth);
    const id = credentialIdOf(auth);
    if (ref && id) {
      throw apiError(400, 'invalid_credential_reference' as any, 'workflow auth cannot contain both credentialRef and credentialId', {
        credentialRef: ref,
        credentialId: id,
      });
    }
    let binding: CredentialBinding;
    if (ref) {
      if (ref !== ORG_CREDENTIAL_REF) {
        throw apiError(400, 'invalid_credential_reference' as any, `unsupported auth.credentialRef '${ref}'`, {
          credentialRef: ref,
          supported: [ORG_CREDENTIAL_REF],
        });
      }
      const header = credentialHeader(auth);
      binding = await ensureOrgCredential(technical, cache);
      binding = { ...binding, header };
    } else if (id) {
      if (!options.allowExistingIds) {
        throw apiError(400, 'invalid_credential_reference' as any, 'portable workflow bundles must use auth.credentialRef, not an environment-local credentialId', {
          credentialId: id,
          requiredRef: ORG_CREDENTIAL_REF,
        });
      }
      const header = credentialHeader(auth);
      binding = { ...(await resolveExistingCredential(technical, id, cache)), header };
    } else {
      return raw;
    }
    bindings.set(binding.credentialId, binding);
    parameters.auth = {
      ...auth,
      credentialId: binding.credentialId,
      header: binding.header,
      allowedOrigins: [options.publicOrigin],
    };
    delete (parameters.auth as Record<string, unknown>).credentialRef;
    return { ...raw, parameters };
  }));
  return {
    definition: { ...definition, nodes },
    bindings: [...bindings.values()],
  };
}

/** Replace deployed credential ids with portable refs for export. */
function exportCredentialRefs(
  definition: Definition,
  bindings: CredentialBinding[] | undefined,
): Definition {
  const byId = new Map((bindings || []).map((binding) => [binding.credentialId, binding]));
  const nodes = definition.nodes.map((raw) => {
    if (!isHttpRequestNode(raw) || !raw.parameters || typeof raw.parameters !== 'object' || Array.isArray(raw.parameters)) {
      return raw;
    }
    const parameters = { ...(raw.parameters as Record<string, unknown>) };
    const authValue = parameters.auth;
    if (!authValue || typeof authValue !== 'object' || Array.isArray(authValue)) return raw;
    const auth = { ...(authValue as Record<string, unknown>) };
    const id = credentialIdOf(auth);
    if (!id) return raw;
    const binding = byId.get(id);
    if (!binding) {
      throw apiError(409, 'unbound_credential_reference' as any, 'the live workflow references a credential without a DX binding; rebind auth.credentialRef before export', {
        credentialId: id,
        requiredRef: ORG_CREDENTIAL_REF,
      });
    }
    const portableAuth: Record<string, unknown> = {
      ...auth,
      credentialRef: binding.name,
      header: binding.header,
    };
    delete portableAuth.credentialId;
    delete portableAuth.allowedOrigins;
    parameters.auth = portableAuth;
    return { ...raw, parameters };
  });
  return { ...definition, nodes };
}

/* ------------------------------------------------------------------------- *
 * Auth, tenancy and storage helpers
 * ------------------------------------------------------------------------- */

interface ArtifactDocument extends StoredDocument<WorkflowArtifactRecord> {}

function artifactId(value: unknown): string {
  const id = String(value ?? '').trim();
  if (!ID_RE.test(id)) throw apiError(404, 'not_found', 'workflow artifact not found');
  return id;
}

function workflowIdValue(value: unknown): string {
  const id = String(value ?? '').trim();
  if (!WORKFLOW_ID_RE.test(id)) throw apiError(400, 'invalid_document', 'workflowId is invalid');
  return id;
}

function tenantVisible(record: WorkflowArtifactRecord, principal: { tenantKey: string; scopes: string[] }): boolean {
  return isAdmin(principal as any) || record.tenant === principal.tenantKey;
}

function canMutate(record: WorkflowArtifactRecord, principal: { subject: string; scopes: string[] }): boolean {
  return isAdmin(principal as any) || record.createdBy === principal.subject;
}

function loadAccessible(
  document: ArtifactDocument | null,
  principal: { tenantKey: string; scopes: string[] },
): WorkflowArtifactRecord {
  if (!document || !tenantVisible(document.data, principal)) {
    throw apiError(404, 'not_found', 'workflow artifact not found');
  }
  return document.data;
}

function callerWorkflowClient(config: ServiceConfig, caller: Caller): SynapseOneClient {
  if (!caller.authenticated || !caller.credential) {
    throw apiError(401, 'unauthorized', 'a verified Tier-1 credential is required for workflow operations');
  }
  return credentialClient(config, caller.credential);
}

/**
 * Technical artifacts are always accessed with the per-organization service
 * identity. Legacy user-owned artifacts stay on the caller credential and are
 * never re-stamped into owner-only by another member.
 */
async function artifactWorkflowClient(
  config: ServiceConfig,
  caller: Caller,
  artifact: WorkflowArtifactRecord,
): Promise<SynapseOneClient> {
  if (artifact.managedBy === 'technical') {
    const technical = await requireOrgWorkflowIdentity(config, artifact.tenant);
    return technical.client;
  }
  return callerWorkflowClient(config, caller);
}

async function ensureWorkflowCollections(client: SynapseOneClient): Promise<void> {
  for (const name of [ARTIFACT_COLLECTION, VERSION_COLLECTION]) {
    try {
      await client.base.getCollection(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await client.base.createCollection({ name, description: `SynapseDX workflow artifact ${name}` });
      } catch (createError) {
        if (!(createError instanceof SynapseOneError && (createError.status === 400 || createError.status === 409))) {
          throw createError;
        }
      }
    }
  }
}

function safeUpstreamMessage(error: unknown): string {
  const body = error instanceof SynapseOneError ? (error.body as Record<string, unknown> | undefined) : undefined;
  const message = String(body?.message || (error as Error)?.message || 'the Tier-1 workflow service rejected the request');
  return scrubString(message).slice(0, 400);
}

function workflowError(error: unknown): never {
  if (error instanceof SynapseOneError) {
    if (error.status === 404) throw apiError(404, 'not_found', 'the Tier-1 workflow was not found');
    if (error.status === 409) throw apiError(409, 'upstream_conflict', safeUpstreamMessage(error));
    if (error.status === 400 || error.status === 422) {
      throw apiError(400, 'query_rejected', safeUpstreamMessage(error));
    }
    if (error.status === 401 || error.status === 403) {
      throw apiError(403, 'forbidden', 'the caller credential cannot access this Tier-1 workflow');
    }
    throw apiError(503, 'tier1_capability_unavailable', 'the Tier-1 workflow service is unavailable', {
      dependency: 'synapseone-workflow',
    });
  }
  throw error;
}

function workflowIdOf(payload: any): string {
  return String(payload?.id || payload?.workflowId || payload?.workflow?.id || '');
}

function workflowApiRevision(payload: any): number | undefined {
  const value = Number(payload?.revision ?? payload?.workflowRevision);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function extractDefinitionFromWorkflow(payload: any, maxNodes = MAX_NODES): Definition {
  const nodes = payload?.nodes ?? payload?.definition?.nodes;
  const connections = payload?.connections ?? payload?.definition?.connections;
  const settings = payload?.settings ?? payload?.definition?.settings ?? {};
  return validateWorkflowDefinition({ nodes, connections, settings }, { maxNodes });
}

function artifactResponse(record: WorkflowArtifactRecord, version: number): Record<string, unknown> {
  const { credentialBindings, ...metadata } = record;
  return {
    ...metadata,
    credentialBindingCount: credentialBindings?.length || 0,
    credentialNames: [...new Set((credentialBindings || []).map((binding) => binding.name))],
    version,
  };
}

function artifactView(document: ArtifactDocument): Record<string, unknown> {
  return artifactResponse(document.data, document.version);
}

/** List view: metadata plus a node count, never the full graph or ids. */
function artifactSummary(document: ArtifactDocument): Record<string, unknown> {
  const { nodes, connections, settings, credentialBindings, ...metadata } = document.data;
  void connections;
  void settings;
  return {
    ...metadata,
    nodeCount: Array.isArray(nodes) ? nodes.length : 0,
    credentialBindingCount: credentialBindings?.length || 0,
    credentialNames: [...new Set((credentialBindings || []).map((binding) => binding.name))],
    version: document.version,
  };
}

async function loadArtifact(
  client: SynapseOneClient,
  id: string,
): Promise<ArtifactDocument> {
  const document = await getDocumentOrNull<WorkflowArtifactRecord>(client, ARTIFACT_COLLECTION, id);
  if (!document) throw apiError(404, 'not_found', 'workflow artifact not found');
  return document;
}

async function saveRevision(
  client: SynapseOneClient,
  artifact: WorkflowArtifactRecord,
): Promise<boolean> {
  const record: WorkflowArtifactVersionRecord = {
    id: `${artifact.id}:${artifact.revision}`,
    artifactId: artifact.id,
    tenant: artifact.tenant,
    revision: artifact.revision,
    ...(artifact.workflowRevision !== undefined ? { workflowRevision: artifact.workflowRevision } : {}),
    checksum: artifact.checksum,
    createdBy: artifact.updatedBy || artifact.createdBy,
    createdAt: artifact.updatedAt,
    nodes: artifact.nodes,
    connections: artifact.connections,
    settings: artifact.settings,
    credentialRedactions: artifact.credentialRedactions,
  };
  try {
    await client.base.createDocument(VERSION_COLLECTION, {
      id: record.id,
      data: record as unknown as Record<string, unknown>,
    });
  } catch (error) {
    if (error instanceof SynapseOneError && (error.status === 409 || error.status === 400)) return true;
    return false;
  }
  return true;
}

/**
 * Persist the terminal revision-history status (best effort). If this fails the
 * artifact keeps `pending`, which is explicit and retryable by reconcile.
 */
async function markVersionHistory(
  client: SynapseOneClient,
  id: string,
  revision: number,
  expectedVersion: number,
  status: 'complete' | 'incomplete',
  error?: string,
): Promise<{ version: number; status: 'complete' | 'incomplete' | 'pending' } | null> {
  try {
    const current = await loadArtifact(client, id);
    if (current.data.revision !== revision) return null;
    const data = {
      ...current.data,
      versionHistoryStatus: status,
      ...(error ? { versionHistoryError: scrubString(error).slice(0, 400) } : {}),
    };
    if (!error) delete (data as WorkflowArtifactRecord).versionHistoryError;
    const saved = await client.base.updateDocument(ARTIFACT_COLLECTION, id, {
      data: data as unknown as Record<string, unknown>,
      ifVersion: expectedVersion,
    });
    return { version: saved.version, status };
  } catch {
    return null;
  }
}

function provenance(value: unknown): WorkflowArtifactSource | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(400, 'invalid_document', 'source must be an object');
  }
  const raw = value as Record<string, unknown>;
  const repository = optionalString(raw.repository, 'source.repository', 300);
  if (repository) {
    let url: URL;
    try {
      url = new URL(repository);
    } catch {
      throw apiError(400, 'invalid_url', 'source.repository must be an absolute GitHub HTTPS URL');
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash) {
      throw apiError(400, 'invalid_url', 'source.repository must be a public https://github.com/... URL');
    }
    if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) {
      throw apiError(400, 'invalid_url', 'source.repository must be a GitHub repository URL');
    }
  }
  const path = optionalString(raw.path, 'source.path', 500);
  if (path && (path.startsWith('/') || path.includes('..') || path.includes('\\'))) {
    throw apiError(400, 'invalid_document', 'source.path must be a relative repository path without ..');
  }
  const revision = optionalString(raw.revision, 'source.revision', 120);
  if (revision && !/^[A-Za-z0-9._/-]+$/.test(revision)) {
    throw apiError(400, 'invalid_document', 'source.revision contains unsupported characters');
  }
  return {
    kind: 'bundle',
    ...(repository ? { repository } : {}),
    ...(path ? { path } : {}),
    ...(revision ? { revision } : {}),
  };
}

function parsePlainObject(value: unknown, label: string, maxBytes: number): Record<string, unknown> {
  const cloned = jsonClone(value, label, maxBytes);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw apiError(400, 'invalid_document', `${label} must be a JSON object`);
  }
  assertNoDangerousKeys(cloned, label);
  return cloned;
}

/* ------------------------------------------------------------------------- *
 * Two-phase update / reconciliation helpers
 * ------------------------------------------------------------------------- */

interface LiveWorkflow {
  name: string;
  definition: Definition;
  active: boolean;
  revision?: number;
  /** Checksum of the scrubbed live graph. */
  checksum: string;
}

function syncStateOf(artifact: WorkflowArtifactRecord): 'ready' | 'pending' | 'failed' {
  return artifact.syncState || 'ready';
}

function assertUsableArtifact(artifact: WorkflowArtifactRecord): void {
  const state = syncStateOf(artifact);
  if (state !== 'ready') {
    throw apiError(409, 'illegal_transition', `workflow artifact is ${state}; reconcile it before use`, {
      syncState: state,
      ...(artifact.syncError ? { syncError: artifact.syncError } : {}),
      ...(artifact.pendingRevision !== undefined ? { pendingRevision: artifact.pendingRevision } : {}),
    });
  }
}

function outOfSync(message: string, details: Record<string, unknown>): never {
  throw apiError(409, 'artifact_out_of_sync' as any, message, details);
}

function compensationFailure(details: Record<string, unknown>): never {
  throw apiError(
    503,
    'artifact_compensation_failed' as any,
    'the Tier-1 workflow was changed but DX could not finalise or compensate the artifact; reconcile it before retrying',
    details,
  );
}

/** Read the authoritative Tier-1 graph (raw for rollback, scrubbed for checksum). */
async function readLiveWorkflow(
  workflowClient: SynapseOneClient,
  workflowId: string,
): Promise<LiveWorkflow> {
  let workflow: any;
  try {
    workflow = await workflowClient.workflow.getWorkflow(workflowId);
  } catch (error) {
    workflowError(error);
  }
  if (!workflow || !Array.isArray(workflow.nodes)) {
    throw apiError(503, 'tier1_capability_unavailable', 'Tier-1 returned no workflow definition', {
      dependency: 'synapseone-workflow',
    });
  }
  const raw = extractDefinitionFromWorkflow(workflow, 500);
  const scrubbed = scrubWorkflowDefinition(raw);
  return {
    name: String(workflow.name || 'workflow'),
    definition: raw,
    active: workflow.active === true,
    ...(workflowApiRevision(workflow) !== undefined ? { revision: workflowApiRevision(workflow) } : {}),
    checksum: workflowGraphChecksum(scrubbed.definition),
  };
}

/** Best-effort compensation back to the live graph captured before mutation. */
async function restoreTier1Workflow(
  workflowClient: SynapseOneClient,
  workflowId: string,
  previous: LiveWorkflow,
): Promise<boolean> {
  try {
    await workflowClient.workflow.updateWorkflow(workflowId, {
      name: previous.name,
      definition: { nodes: previous.definition.nodes, connections: previous.definition.connections },
      settings: previous.definition.settings,
    });
    if (previous.active) await workflowClient.workflow.activateWorkflow(workflowId);
    else await workflowClient.workflow.deactivateWorkflow(workflowId);
    return true;
  } catch {
    return false;
  }
}

/** Restore the pre-update Base snapshot only while we still own the pending CAS. */
async function restoreArtifactSnapshot(
  client: SynapseOneClient,
  id: string,
  original: WorkflowArtifactRecord,
  pendingRevision: number,
): Promise<boolean> {
  try {
    const current = await loadArtifact(client, id);
    const ownsPending = current.data.syncState === 'pending' && current.data.pendingRevision === pendingRevision;
    const ownsFinalized = current.data.syncState === 'ready' && current.data.revision === pendingRevision;
    if (!ownsPending && !ownsFinalized) return false;
    await client.base.updateDocument(ARTIFACT_COLLECTION, id, {
      data: original as unknown as Record<string, unknown>,
      ifVersion: current.version,
    });
    return true;
  } catch {
    return false;
  }
}

/** Persist an explicit failed marker; never reports success or silently stale. */
async function markArtifactSyncFailed(
  client: SynapseOneClient,
  id: string,
  pendingRevision: number,
  message: string,
): Promise<boolean> {
  try {
    const current = await loadArtifact(client, id);
    const ownsPending = current.data.syncState === 'pending' && current.data.pendingRevision === pendingRevision;
    const ownsFinalized = current.data.syncState === 'ready' && current.data.revision === pendingRevision;
    if (!ownsPending && !ownsFinalized) return false;
    await client.base.updateDocument(ARTIFACT_COLLECTION, id, {
      data: {
        ...current.data,
        syncState: 'failed',
        syncError: scrubString(message).slice(0, 400),
      } as unknown as Record<string, unknown>,
      ifVersion: current.version,
    });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------- *
 * Published-SDK revision-pin gate
 * ------------------------------------------------------------------------- */

let cachedSdkVersion: string | null | undefined;

function installedSynapseOneSdkVersion(): string | null {
  if (cachedSdkVersion !== undefined) return cachedSdkVersion;
  try {
    // The published package exports ./package.json; reading metadata does not
    // consume an unpublished operation or call Tier-1.
    const pkg = require('@synapseone/sdk/package.json') as { version?: unknown };
    cachedSdkVersion = typeof pkg?.version === 'string' ? pkg.version : null;
  } catch {
    cachedSdkVersion = null;
  }
  return cachedSdkVersion;
}

/** Test seam: only usable in NODE_ENV=test; never a production override. */
export function __setWorkflowSdkVersionForTests(version: string | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('workflow SDK test override is test-only');
  cachedSdkVersion = version;
}

/** Strict semver (no prerelease/build suffix) >= the minimum release. */
export function isWorkflowRevisionPinVersionSupported(version: string | null | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
  if (!match) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major > 0) return true;
  if (minor > 9) return true;
  return minor === 9 && patch >= 1;
}

export interface WorkflowArtifactExecutionReadiness {
  ready: boolean;
  installedVersion: string | null;
  minimumVersion: string;
  requirement: string;
  canSubmit: boolean;
}

async function workflowRunnerOptions(client: SynapseOneClient): Promise<any> {
  const workflow = client.workflow as any;
  if (typeof workflow?.getWorkflowRunnerOptions !== 'function') {
    const error: any = new Error('the installed @synapseone/sdk lacks getWorkflowRunnerOptions()');
    error.code = 'workflow_runner_options_method_missing';
    throw error;
  }
  return workflow.getWorkflowRunnerOptions();
}

export interface WorkflowCredentialDestinationReadiness {
  ready: boolean;
  admittedByEngine: boolean;
  engineMarker: number | null;
  requirement: string;
  reason?: string;
}

/**
 * Capability detection through the already-published SDK method
 * `workflow.getWorkflowRunnerOptions()`. Old images have no engineCapabilities,
 * so key binding and plugin execution fail closed before create/rotate.
 */
export async function getWorkflowCredentialDestinationReadiness(
  config: ServiceConfig,
  org: string,
): Promise<WorkflowCredentialDestinationReadiness> {
  let technical: OrgWorkflowIdentity;
  try {
    technical = await requireOrgWorkflowIdentity(config, org);
  } catch (error) {
    return {
      ready: false,
      admittedByEngine: false,
      engineMarker: null,
      requirement: 'A verified per-organization technical workflow identity is required',
      reason: (error as any)?.code || 'technical_identity_unavailable',
    };
  }
  let options: any;
  try {
    options = await workflowRunnerOptions(technical.client);
  } catch (error) {
    return {
      ready: false,
      admittedByEngine: false,
      engineMarker: null,
      requirement: (error as any)?.code === 'workflow_runner_options_method_missing'
        ? 'The installed @synapseone/sdk does not expose getWorkflowRunnerOptions(); install the published SDK release with runner options'
        : 'Tier-1 workflow runner options are unavailable',
      reason: (error as any)?.code || 'workflow_options_unavailable',
    };
  }
  const capabilities = options?.engineCapabilities || {};
  const marker = Number(capabilities.httpCredentialDestinationProtection);
  const ready = capabilities.httpCredentialAllowedOrigins === true && marker === 1;
  return {
    ready,
    admittedByEngine: capabilities.httpCredentialAllowedOrigins === true,
    engineMarker: Number.isFinite(marker) ? marker : null,
    requirement: ready
      ? 'Tier-1 engine enforces auth.allowedOrigins before credential resolution and on every redirect'
      : 'Credential destination protection is unavailable: deploy the Tier-1 engine build that advertises engineCapabilities.httpCredentialAllowedOrigins=true',
    ...(ready ? {} : { reason: 'engine_credential_origin_protection_missing' }),
  };
}

async function requireCredentialDestinationProtection(technical: OrgWorkflowIdentity): Promise<void> {
  let options: any;
  try {
    options = await workflowRunnerOptions(technical.client);
  } catch (error) {
    throw apiError(503, 'dependency_unavailable', 'Tier-1 workflow runner options are unavailable; credential binding is disabled', {
      dependency: 'synapseone-workflow',
      credentialDestinationProtection: false,
      reason: (error as any)?.code || 'workflow_options_unavailable',
    });
  }
  const capabilities = options?.engineCapabilities || {};
  if (capabilities.httpCredentialAllowedOrigins === true
    && Number(capabilities.httpCredentialDestinationProtection) === 1) return;
  throw apiError(503, 'dependency_unavailable', 'the deployed Tier-1 engine does not enforce auth.allowedOrigins; credential binding is disabled', {
    dependency: 'synapseone-workflow',
    credentialDestinationProtection: false,
    engineCapabilities: capabilities,
    requiredEngineCapability: 'httpCredentialAllowedOrigins',
  });
}

/**
 * Plugin worker readiness probe: published route handlers should expose this
 * to the console so forms are disabled with a clear release requirement until
 * the installed SDK can pass `expectedRevision`.
 */
export function getWorkflowArtifactExecutionReadiness(): WorkflowArtifactExecutionReadiness {
  const installedVersion = installedSynapseOneSdkVersion();
  const ready = isWorkflowRevisionPinVersionSupported(installedVersion);
  return {
    ready,
    installedVersion,
    minimumVersion: MIN_REVISION_SDK_VERSION,
    requirement: ready
      ? `@synapseone/sdk >=${MIN_REVISION_SDK_VERSION} installed`
      : `Plugin workflow execution requires the published @synapseone/sdk >=${MIN_REVISION_SDK_VERSION} with expectedRevision support; installed ${installedVersion || 'unknown'}`,
    canSubmit: ready,
  };
}

/* ------------------------------------------------------------------------- *
 * Per-organization technical workflow identity
 * ------------------------------------------------------------------------- */

const WORKFLOW_ORG_KEYS_ENV = 'SYNAPSEDX_WORKFLOW_API_KEYS';

interface OrgWorkflowIdentity {
  client: SynapseOneClient;
  org: string;
  accountId: string;
}

interface OrgWorkflowReadiness {
  ready: boolean;
  org: string;
  configured: boolean;
  verified: boolean;
  accountId?: string;
  reason?: string;
  requirement: string;
}

function normalizeOrg(value: unknown): string {
  return String(value || '').trim().replace(/^org:/i, '');
}

function readOrgWorkflowKeys(): Record<string, string> {
  const raw = process.env[WORKFLOW_ORG_KEYS_ENV]?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const output: Record<string, string> = {};
  for (const [org, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const key = typeof entry === 'string'
      ? entry
      : (entry && typeof entry === 'object' && !Array.isArray(entry)
        ? String((entry as Record<string, unknown>).apiKey || '')
        : '');
    const normalized = normalizeOrg(org);
    if (normalized && key.trim()) output[normalized] = key.trim();
  }
  return output;
}

async function inspectOrgWorkflowIdentity(
  config: ServiceConfig,
  org: string,
): Promise<OrgWorkflowReadiness> {
  const normalized = normalizeOrg(org);
  const key = readOrgWorkflowKeys()[normalized];
  if (!key) {
    return {
      ready: false,
      org: normalized,
      configured: false,
      verified: false,
      reason: 'workflow_technical_identity_missing',
      requirement: `No ${WORKFLOW_ORG_KEYS_ENV} entry for this organization; configure an account-level Tier-1 API key before enabling plugin workflow execution`,
    };
  }
  const client = credentialClient(config, { kind: 'api-key', value: key });
  let payload: unknown;
  try {
    payload = await client.iam.verify();
  } catch {
    return {
      ready: false,
      org: normalized,
      configured: true,
      verified: false,
      reason: 'workflow_technical_identity_rejected',
      requirement: 'The configured organization workflow API key was rejected by Tier-1 IAM',
    };
  }
  const body = (payload || {}) as Record<string, any>;
  const claims = (body.claims || {}) as Record<string, any>;
  if (body.valid === false || (!(body.type === 'apikey' || body.account_id))) {
    return {
      ready: false,
      org: normalized,
      configured: true,
      verified: false,
      reason: 'workflow_technical_identity_not_apikey',
      requirement: 'The organization workflow credential must be a Tier-1 account-level API key',
    };
  }
  if (body.user_id || body.userId || claims.user_id || claims.sub) {
    return {
      ready: false,
      org: normalized,
      configured: true,
      verified: false,
      reason: 'workflow_technical_identity_user_bound',
      requirement: 'The organization workflow credential must not be bound to a user',
    };
  }
  const boundOrg = normalizeOrg(body.org_id ?? body.org ?? claims.org_id ?? claims.org);
  if (!boundOrg || boundOrg !== normalized) {
    return {
      ready: false,
      org: normalized,
      configured: true,
      verified: false,
      reason: boundOrg ? 'workflow_technical_identity_org_mismatch' : 'workflow_technical_identity_org_missing',
      requirement: 'The organization workflow API key must be verified by IAM with the exact organization id',
    };
  }
  const accountId = String(body.account_id || '');
  if (!accountId) {
    return {
      ready: false,
      org: normalized,
      configured: true,
      verified: false,
      reason: 'workflow_technical_identity_account_missing',
      requirement: 'The organization workflow API key must resolve to a Tier-1 account',
    };
  }
  return {
    ready: true,
    org: normalized,
    configured: true,
    verified: true,
    accountId,
    requirement: 'Organization technical workflow identity verified',
  };
}

async function requireOrgWorkflowIdentity(
  config: ServiceConfig,
  org: string,
): Promise<OrgWorkflowIdentity> {
  const readiness = await inspectOrgWorkflowIdentity(config, org);
  if (!readiness.ready) {
    throw apiError(503, 'dependency_unavailable', readiness.requirement, {
      ...readiness,
      dependency: 'synapseone-workflow',
      technicalIdentity: false,
      canSubmit: false,
    });
  }
  const key = readOrgWorkflowKeys()[readiness.org];
  if (!key) {
    throw apiError(503, 'dependency_unavailable', 'the organization workflow technical identity is unavailable', {
      org: readiness.org,
      dependency: 'synapseone-workflow',
      technicalIdentity: false,
      canSubmit: false,
    });
  }
  return {
    client: credentialClient(config, { kind: 'api-key', value: key }),
    org: readiness.org,
    accountId: readiness.accountId!,
  };
}

/** Async org readiness for the plugin worker / admin UI. */
export async function getWorkflowArtifactOrgReadiness(
  config: ServiceConfig,
  org: string,
): Promise<OrgWorkflowReadiness> {
  return inspectOrgWorkflowIdentity(config, org);
}

function requireRevisionPinSdk(): void {
  const readiness = getWorkflowArtifactExecutionReadiness();
  if (readiness.ready) return;
  throw apiError(503, 'dependency_unavailable', readiness.requirement, {
    ...readiness,
    dependency: '@synapseone/sdk',
    sdkReleaseRequired: true,
  });
}

/* ------------------------------------------------------------------------- *
 * Plugin delegation helper (library export; the plugin worker owns the route)
 * ------------------------------------------------------------------------- */

export interface WorkflowArtifactPluginExecutionOptions {
  /** Installed plugin id (audit + explicit delegation intent). */
  pluginId: string;
  /** Widget id that binds the workflow artifact. */
  widgetId?: string;
  /** Organization/tenant of the installed plugin; must match the artifact. */
  tenant: string;
  /** Member roles verified server-side for this caller/installation. */
  roles: string[];
  /**
   * Checksum approved when the organization admin published the plugin
   * binding. Required: it pins the exact reviewed artifact graph.
   */
  expectedChecksum: string;
  /** Approved artifact revision (optional but recommended). */
  expectedRevision?: number;
  /** Request correlation id from the plugin endpoint (optional). */
  correlationId?: string;
}

export interface WorkflowArtifactExecutionResult {
  artifactId: string;
  workflowId: string;
  revision: number;
  checksum: string;
  /** True only when the published-SDK expectedRevision gate passed. */
  revisionPinned: boolean;
  expectedWorkflowRevision?: number;
  execution: unknown;
}

async function executeArtifactCore(
  config: ServiceConfig,
  caller: Caller,
  artifact: WorkflowArtifactRecord,
  payload: Record<string, unknown>,
  audit: Record<string, unknown>,
  correlationId: string,
  expectedWorkflowRevision?: number,
  workflowClientOverride?: SynapseOneClient,
): Promise<WorkflowArtifactExecutionResult> {
  const principal = caller.principal;
  if (!principal) throw apiError(401, 'unauthorized', 'a verified credential is required to execute a workflow');
  const workflowClient = workflowClientOverride ?? callerWorkflowClient(config, caller);
  let execution: any;
  if (expectedWorkflowRevision !== undefined) {
    // Fail closed unless the installed published SDK actually supports the
    // expectedRevision transport. Never fall back to an unpinned execute.
    requireRevisionPinSdk();
  }
  try {
    // This branch only runs with @synapseone/sdk >= the published minimum
    // (verified above); the cast narrows the older local type definition.
    const executeWithRevision = workflowClient.workflow.executeWorkflow.bind(workflowClient.workflow) as (
      id: string,
      data?: Record<string, unknown>,
      options?: { expectedRevision?: number },
    ) => Promise<unknown>;
    execution = expectedWorkflowRevision !== undefined
      ? await executeWithRevision(artifact.workflowId, payload, { expectedRevision: expectedWorkflowRevision })
      : await workflowClient.workflow.executeWorkflow(artifact.workflowId, payload);
  } catch (error) {
    workflowError(error);
  }
  const executionId = String(execution?.executionId || execution?.id || execution?.execution?.id || '').slice(0, 128);
  if (executionId) {
    // Best-effort projection; the Tier-1 execution already succeeded.
    try {
      const client = serviceClient(config);
      const current = await loadArtifact(client, artifact.id);
      if (current.data.tenant === artifact.tenant) {
        await client.base.updateDocument(ARTIFACT_COLLECTION, artifact.id, {
          data: {
            ...current.data,
            lastExecutedAt: new Date().toISOString(),
            lastExecutionId: executionId,
          } as unknown as Record<string, unknown>,
          ifVersion: current.version,
        });
      }
    } catch { /* projection only */ }
  }
  await recordAudit(serviceClient(config), config, {
    actor: principal.subject,
    tenant: principal.tenantKey,
    action: 'workflow_artifact.execute',
    correlationId,
    details: {
      id: artifact.id,
      executionId: executionId || null,
      revision: artifact.revision,
      ...(expectedWorkflowRevision !== undefined
        ? { expectedWorkflowRevision, revisionPinRequested: true }
        : {}),
      ...audit,
    },
  });
  return {
    artifactId: artifact.id,
    workflowId: artifact.workflowId,
    revision: artifact.revision,
    checksum: artifact.checksum,
    revisionPinned: expectedWorkflowRevision !== undefined,
    ...(expectedWorkflowRevision !== undefined ? { expectedWorkflowRevision } : {}),
    execution,
  };
}

/**
 * Execute an organization-owned workflow artifact on behalf of an installed
 * plugin widget. The plugin worker must first verify the installation, the
 * widget binding and the member's server-side roles; this helper re-verifies
 * tenant + artifact ownership boundaries and delegates execution to Tier-1
 * with the caller's own credential.
 *
 * This is deliberately a library export (no HTTP route). It does not weaken the
 * owner/admin restriction on the direct `POST /:id/execute` endpoint.
 */
export async function executeWorkflowArtifactForPlugin(
  config: ServiceConfig,
  caller: Caller,
  artifactId: string,
  payload: Record<string, unknown>,
  options: WorkflowArtifactPluginExecutionOptions,
): Promise<WorkflowArtifactExecutionResult> {
  const principal = caller.principal;
  if (!caller.authenticated || !principal || !caller.credential) {
    throw apiError(401, 'unauthorized', 'a verified Tier-1 credential is required to execute a workflow');
  }
  const pluginId = String(options?.pluginId || '').trim();
  const tenant = String(options?.tenant || '').trim();
  const expectedChecksum = String(options?.expectedChecksum || '').trim().toLowerCase();
  const roles = Array.isArray(options?.roles)
    ? options.roles.map((role) => String(role).trim()).filter(Boolean)
    : [];
  if (!pluginId || !tenant || roles.length === 0) {
    throw apiError(403, 'forbidden', 'plugin delegation requires a plugin id, tenant and verified member role');
  }
  if (!/^[a-f0-9]{64}$/.test(expectedChecksum)) {
    throw apiError(403, 'forbidden', 'plugin delegation requires the approved artifact checksum');
  }
  if (principal.tenantKey !== tenant) {
    throw apiError(404, 'not_found', 'workflow artifact not found');
  }
  const id = String(artifactId ?? '').trim();
  if (!ID_RE.test(id)) throw apiError(404, 'not_found', 'workflow artifact not found');
  const client = serviceClient(config);
  const document = await loadArtifact(client, id);
  const artifact = document.data;
  // Plugin delegation is organization-scoped: no admin cross-tenant bypass.
  if (artifact.tenant !== tenant || !tenantVisible(artifact, principal)) {
    throw apiError(404, 'not_found', 'workflow artifact not found');
  }
  assertUsableArtifact(artifact);
  assertPluginProtected(artifact);
  if (options.expectedRevision !== undefined && options.expectedRevision !== artifact.revision) {
    outOfSync('the workflow artifact no longer matches the revision approved by the plugin binding', {
      expectedRevision: options.expectedRevision,
      actualRevision: artifact.revision,
    });
  }
  if (artifact.checksum !== expectedChecksum) {
    outOfSync('the workflow artifact no longer matches the checksum approved by the plugin binding', {
      expectedChecksum,
      actualChecksum: artifact.checksum,
      actualRevision: artifact.revision,
    });
  }
  // Protected artifacts are owned by the per-organization technical identity,
  // never by the member's bearer credential.
  const technical = await requireOrgWorkflowIdentity(config, artifact.tenant);
  if (artifact.credentialBindings?.length || hasCredentialNodes(artifact.nodes)) {
    await requireCredentialDestinationProtection(technical);
  }
  // Pin the reviewed graph to Tier-1 as well: a workflow edited outside DX is
  // unreviewed drift and must not run from an immutable published plugin.
  const live = await readLiveWorkflow(technical.client, artifact.workflowId);
  if (live.checksum !== expectedChecksum || live.checksum !== artifact.checksum) {
    outOfSync('the Tier-1 workflow graph changed outside DX and no longer matches the approved plugin binding', {
      expectedChecksum,
      artifactChecksum: artifact.checksum,
      liveChecksum: live.checksum,
      revision: artifact.revision,
    });
  }
  const expectedWorkflowRevision = live.revision ?? artifact.workflowRevision;
  if (expectedWorkflowRevision === undefined) {
    throw apiError(503, 'dependency_unavailable', 'Tier-1 did not report a workflow revision; pinned execution is unavailable', {
      dependency: 'synapseone-workflow',
      revisionUnavailable: true,
    });
  }
  const body = parsePlainObject(payload ?? {}, 'payload', MAX_EXECUTE_BYTES);
  return executeArtifactCore(config, caller, artifact, body, {
    delegated: true,
    pluginId,
    ...(options.widgetId ? { widgetId: String(options.widgetId).slice(0, 120) } : {}),
    roles: roles.slice(0, 20),
    expectedChecksum,
    liveChecksum: live.checksum,
    managedBy: 'technical',
    technicalAccountId: technical.accountId,
  }, options.correlationId || randomUUID(), expectedWorkflowRevision, technical.client);
}

/* ------------------------------------------------------------------------- *
 * Route registration
 * ------------------------------------------------------------------------- */

export function registerWorkflowArtifactRoutes(app: Express, config: ServiceConfig): void {
  const base = '/v1/capabilities/workflow-artifacts';

  // ---- list ----
  app.get(base, handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const pagination = parsePagination(req, config.maxPageSize);
    const where = isAdmin(principal) ? undefined : { tenant: principal.tenantKey };
    const result = await queryDocuments<WorkflowArtifactRecord>(client, ARTIFACT_COLLECTION, {
      ...(where ? { where } : {}),
      orderBy: { field: 'updatedAt', direction: 'desc' },
      limit: pagination.limit,
      offset: pagination.offset,
    });
    setPageHeaders(res, { total: result.total, limit: pagination.limit, offset: pagination.offset, nextCursor: result.nextCursor });
    res.json({
      items: result.items.map((item) => artifactSummary(item)),
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
      nextCursor: result.nextCursor,
    });
  }));

  // ---- execution readiness (plugin forms gate) ----
  app.get(`${base}/readiness`, handler(async (req, res) => {
    const { principal } = await authenticatedReadContext(req, config);
    const readiness = getWorkflowArtifactExecutionReadiness();
    const technicalIdentity = await getWorkflowArtifactOrgReadiness(config, principal.tenantKey);
    const credentialDestination = await getWorkflowCredentialDestinationReadiness(config, principal.tenantKey);
    res.json({
      workflowExecution: readiness,
      workflowTechnicalIdentity: technicalIdentity,
      workflowCredentialDestinationProtection: credentialDestination,
      pluginFormsCanSubmit: readiness.canSubmit && technicalIdentity.ready && credentialDestination.ready,
      directManagementExecute: true,
    });
  }));

  // ---- import / create ----
  app.post(`${base}/import`, handler(async (req, res) => {
    const { caller, principal, client } = await writeContext(req, config);
    const callerClient = callerWorkflowClient(config, caller);
    const body = parsePlainObject(req.body || {}, 'body', MAX_DEFINITION_BYTES + 16 * 1024);
    // Import modes are mutually exclusive: a portable bundle, a snapshot of an
    // existing Tier-1 workflow, or a raw definition that creates a workflow.
    const bundle = body.bundle && typeof body.bundle === 'object' && !Array.isArray(body.bundle)
      ? body.bundle as Record<string, unknown>
      : body;
    const isBundle = String(bundle.format || '') === FORMAT || !!bundle.workflow;
    const snapshotId = body.workflowId !== undefined ? workflowIdValue(body.workflowId) : '';
    const rawDefinition = body.definition !== undefined
      ? body.definition
      : (!isBundle && snapshotId === '' ? { nodes: body.nodes, connections: body.connections, settings: body.settings } : undefined);
    const modes = [isBundle, snapshotId !== '', rawDefinition !== undefined].filter(Boolean).length;
    if (modes !== 1) {
      throw apiError(400, 'invalid_document', 'pass exactly one of bundle, workflowId or definition');
    }
    if (snapshotId && body.clone !== true) {
      throw apiError(409, 'clone_required' as any, 'existing Tier-1 workflows are cloned into a protected DX-managed workflow; pass clone:true', {
        workflowId: snapshotId,
        required: 'clone:true',
      });
    }
    if (isBundle && (String(bundle.format || '') !== FORMAT || Number(bundle.formatVersion) !== FORMAT_VERSION)) {
      throw apiError(400, 'invalid_document', `bundle must be ${FORMAT} formatVersion ${FORMAT_VERSION}`);
    }

    let name = requiredName(
      body.name ?? (isBundle ? (bundle.artifact as any)?.name ?? (bundle.workflow as any)?.name : undefined),
      'Imported workflow',
    );
    const description = optionalString(
      body.description ?? (isBundle ? (bundle.artifact as any)?.description : undefined),
      'description',
      MAX_DESCRIPTION,
    );
    const slug = optionalString(body.slug ?? (isBundle ? (bundle.artifact as any)?.slug : undefined), 'slug', 120);
    if (slug && !/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) {
      throw apiError(400, 'invalid_document', 'slug must be lowercase letters, digits and dashes');
    }
    const source = provenance(body.source ?? (isBundle ? bundle.source : undefined));
    const activate = body.activate === true;

    let proposed: Definition;
    let cloneActive = false;
    if (isBundle) {
      if (!bundle.workflow || typeof bundle.workflow !== 'object' || Array.isArray(bundle.workflow)) {
        throw apiError(400, 'invalid_document', 'bundle.workflow must be an object');
      }
      proposed = validateWorkflowDefinition(bundle.workflow);
    } else if (snapshotId) {
      let existing: any;
      try {
        // Read with the caller credential only to respect their legacy access;
        // never mutate or re-stamp the existing workflow.
        existing = await callerClient.workflow.getWorkflow(snapshotId);
      } catch (error) {
        workflowError(error);
      }
      proposed = extractDefinitionFromWorkflow(existing);
      cloneActive = existing?.active === true;
      if (body.name === undefined) name = requiredName(existing?.name, name);
    } else {
      proposed = validateWorkflowDefinition(rawDefinition);
    }

    // Owner-only policy is mandatory for every newly managed/cloned workflow.
    // Unknown/other access modes are rejected instead of being silently
    // overwritten (source compatibility guard).
    assertSupportedAccess(proposed.settings, 'workflow.settings');
    proposed = { ...proposed, settings: withOwnerOnly(proposed.settings) };
    const technical = await requireOrgWorkflowIdentity(config, principal.tenantKey);
    const scrubbed = scrubWorkflowDefinition(proposed);
    // Portable checksum covers the ref graph; the deployed checksum covers the
    // bound credential-id graph. Verify a bundle before creating/rotating any
    // credential side effect.
    let portableChecksum = workflowGraphChecksum(scrubbed.definition);
    if (isBundle && bundle.checksum !== undefined && String(bundle.checksum) !== portableChecksum) {
      throw apiError(400, 'checksum_mismatch' as any, 'the portable workflow checksum does not match the bundle', {
        expected: portableChecksum,
        actual: String(bundle.checksum),
      });
    }
    const bound = await bindWorkflowCredentials(technical, scrubbed.definition, {
      // A legacy snapshot may contain a credential id already owned by the
      // technical identity; portable bundles must use refs only.
      allowExistingIds: snapshotId !== '',
      publicOrigin: new URL(config.publicUrl).origin,
    });
    const deployedDefinition = bound.definition;
    const checksum = workflowGraphChecksum(deployedDefinition);
    if (snapshotId) {
      portableChecksum = workflowGraphChecksum(exportCredentialRefs(deployedDefinition, bound.bindings));
    }
    let workflowId = '';
    let workflowRevision: number | undefined;
    let active = false;
    let createdWorkflow = false;

    try {
      // The per-organization technical identity owns protected workflows. The
      // caller credential is only used for the legacy clone read above.
      let created: any;
      try {
        created = await technical.client.workflow.createWorkflow(
          name,
          { nodes: deployedDefinition.nodes, connections: deployedDefinition.connections },
          deployedDefinition.settings,
        );
      } catch (error) {
        workflowError(error);
      }
      workflowId = workflowIdOf(created);
      if (!workflowId) {
        throw apiError(503, 'tier1_capability_unavailable', 'SynapseOne did not return a workflow id', {
          dependency: 'synapseone-workflow',
        });
      }
      createdWorkflow = true;
      workflowRevision = workflowApiRevision(created);
      active = created?.active === true;
      if (activate || cloneActive) {
        try {
          const activated = await technical.client.workflow.activateWorkflow(workflowId) as any;
          active = activated?.active !== false;
        } catch (error) {
          workflowError(error);
        }
      }

      await ensureWorkflowCollections(client);
      const now = new Date().toISOString();
      const artifact: WorkflowArtifactRecord = {
        id: randomUUID(),
        tenant: principal.tenantKey,
        createdBy: principal.subject,
        createdAt: now,
        updatedAt: now,
        name,
        ...(description ? { description } : {}),
        ...(slug ? { slug } : {}),
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        revision: 1,
        workflowId,
        ...(workflowRevision !== undefined ? { workflowRevision } : {}),
        active,
        nodes: deployedDefinition.nodes,
        connections: deployedDefinition.connections,
        settings: deployedDefinition.settings,
        source: source
          ? { ...source, kind: snapshotId ? 'tier1-workflow' : isBundle ? 'bundle' : 'definition' }
          : { kind: snapshotId ? 'tier1-workflow' : isBundle ? 'bundle' : 'definition' },
        checksum,
        portableChecksum,
        credentialBindings: bound.bindings,
        credentialRedactions: scrubbed.redactions,
        versionCount: 1,
        syncState: 'ready',
        versionHistoryStatus: 'pending',
        managedBy: 'technical',
        ...protectedArtifact(deployedDefinition.settings),
      };
      const createdDocument = await client.base.createDocument(ARTIFACT_COLLECTION, {
        id: artifact.id,
        data: artifact as unknown as Record<string, unknown>,
      });
      let documentVersion = createdDocument.version;
      const historyOk = await saveRevision(client, artifact);
      const marked = await markVersionHistory(
        client, artifact.id, 1, documentVersion,
        historyOk ? 'complete' : 'incomplete',
        historyOk ? undefined : 'revision snapshot write failed',
      );
      if (marked) documentVersion = marked.version;
      await recordAudit(client, config, {
        actor: principal.subject,
        tenant: principal.tenantKey,
        action: 'workflow_artifact.import',
        correlationId: correlationIdOf(req),
        details: {
          id: artifact.id,
          workflowId,
          revision: 1,
          redactions: scrubbed.redactions.length,
          mode: snapshotId ? 'snapshot' : 'create',
        },
      });
      res.status(201).json({
        ...artifactResponse(artifact, documentVersion),
        versionHistoryStatus: marked?.status ?? 'pending',
      });
    } catch (error) {
      if (createdWorkflow && workflowId) {
        try {
          await technical.client.workflow.deactivateWorkflow(workflowId);
        } catch { /* already inactive */ }
        try {
          await technical.client.workflow.deleteWorkflow(workflowId);
        } catch { /* history may be retained */ }
      }
      if (error instanceof SynapseOneError) workflowError(error);
      throw error;
    }
  }));

  // ---- get ----
  app.get(`${base}/:id`, handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const id = artifactId(req.params.id);
    const document = await loadArtifact(client, id);
    loadAccessible(document, principal);
    res.json(artifactView(document));
  }));

  // ---- update (CAS first, then Tier-1, then finalize) ----
  app.put(`${base}/:id`, handler(async (req, res) => {
    const { caller, principal, client } = await writeContext(req, config);
    const id = artifactId(req.params.id);
    const document = await loadArtifact(client, id);
    const artifact = loadAccessible(document, principal);
    if (!canMutate(artifact, principal)) {
      throw apiError(403, 'forbidden', 'only the artifact owner or a DX administrator may update this artifact');
    }
    assertUsableArtifact(artifact);
    if (artifact.managedBy !== 'technical') {
      throw apiError(409, 'legacy_workflow_requires_clone' as any, 'this artifact owns a legacy user-owned workflow; clone it into a protected technical workflow before editing', {
        managedBy: artifact.managedBy || 'user',
        required: 'technical + owner-only',
      });
    }
    const technical = await requireOrgWorkflowIdentity(config, artifact.tenant);
    const workflowClient = technical.client;
    const body = parsePlainObject(req.body || {}, 'body', MAX_DEFINITION_BYTES + 16 * 1024);
    if (body.force !== undefined && typeof body.force !== 'boolean') {
      throw apiError(400, 'invalid_document', 'force must be a boolean');
    }
    const force = body.force === true;
    const requestedVersion = expectedVersion(req, body);

    const name = body.name !== undefined ? requiredName(body.name) : artifact.name;
    const description = body.description !== undefined
      ? optionalString(body.description, 'description', MAX_DESCRIPTION)
      : artifact.description;
    const graphProvided = body.definition !== undefined || body.nodes !== undefined || body.connections !== undefined;
    const definitionInput = body.definition !== undefined
      ? body.definition
      : graphProvided
        ? { nodes: body.nodes, connections: body.connections, settings: body.settings }
        : undefined;

    let scrubbed: ScrubResult | undefined;
    if (definitionInput !== undefined) {
      scrubbed = scrubWorkflowDefinition(validateWorkflowDefinition(definitionInput));
    } else if (body.settings !== undefined) {
      scrubbed = scrubWorkflowDefinition(validateWorkflowDefinition({
        nodes: artifact.nodes,
        connections: artifact.connections,
        settings: body.settings,
      }));
    }
    const nextNodes = scrubbed?.definition.nodes ?? artifact.nodes;
    const nextConnections = scrubbed?.definition.connections ?? artifact.connections;
    const requestedSettings = scrubbed?.definition.settings ?? artifact.settings;
    const graphChanged = definitionInput !== undefined || body.settings !== undefined;

    // Capture the authoritative graph for drift detection and rollback before
    // touching anything. External drift requires an explicit `force`.
    const live = await readLiveWorkflow(workflowClient, artifact.workflowId);
    if (live.checksum !== artifact.checksum && !force) {
      outOfSync('the Tier-1 workflow changed outside DX; reconcile the artifact or resend with force=true', {
        artifactChecksum: artifact.checksum,
        liveChecksum: live.checksum,
      });
    }
    // Preserve Tier-1 settings that DX does not own, reject unknown access
    // semantics, and always re-assert owner-only on the managed workflow.
    assertSupportedAccess(live.definition.settings, 'workflow.settings');
    assertSupportedAccess(requestedSettings, 'settings');
    const nextSettings = withOwnerOnly({ ...live.definition.settings, ...requestedSettings });

    const now = new Date().toISOString();
    const pendingRevision = artifact.revision + 1;
    let pendingVersion: number;
    try {
      // CAS guard is acquired BEFORE any credential or Tier-1 mutation. A
      // stale/concurrent update fails here and never creates/rotates a
      // credential or changes the workflow.
      const pending = await client.base.updateDocument(ARTIFACT_COLLECTION, id, {
        data: {
          ...artifact,
          syncState: 'pending',
          pendingRevision,
          pendingChecksum: artifact.checksum, // final deployed checksum is set on finalize
          pendingUpdatedAt: now,
          updatedBy: principal.subject,
          updatedAt: now,
        } as unknown as Record<string, unknown>,
        ifVersion: requestedVersion ?? document.version,
      });
      pendingVersion = pending.version;
    } catch (error) {
      if (error instanceof SynapseOneError && error.status === 409) {
        throw apiError(409, 'version_conflict', 'the workflow artifact was modified by another request');
      }
      throw error;
    }

    let deployedDefinition: Definition;
    let deployedChecksum: string;
    let portableChecksum: string;
    let credentialBindings: CredentialBinding[];
    try {
      const bound = await bindWorkflowCredentials(
        technical,
        { nodes: nextNodes, connections: nextConnections, settings: nextSettings },
        { allowExistingIds: true, publicOrigin: new URL(config.publicUrl).origin },
      );
      deployedDefinition = bound.definition;
      deployedChecksum = workflowGraphChecksum(deployedDefinition);
      portableChecksum = workflowGraphChecksum(exportCredentialRefs(deployedDefinition, bound.bindings));
      credentialBindings = bound.bindings;
    } catch (error) {
      const baseRestore = await restoreArtifactSnapshot(client, id, artifact, pendingRevision);
      if (!baseRestore) {
        await markArtifactSyncFailed(client, id, pendingRevision, 'credential binding failed and Base rollback failed');
        compensationFailure({ stage: 'credential_binding', tier1Rollback: 'skipped', baseRestore: false, pendingRevision });
      }
      throw error;
    }

    let workflowRevision = live.revision ?? artifact.workflowRevision;
    let active = live.active;
    let mutationError: unknown;
    try {
      const patch: Record<string, unknown> = {};
      if (name !== artifact.name) patch.name = name;
      if (graphChanged) {
        patch.definition = { nodes: deployedDefinition.nodes, connections: deployedDefinition.connections };
        patch.settings = deployedDefinition.settings;
      }
      if (Object.keys(patch).length) {
        const updated = await workflowClient.workflow.updateWorkflow(artifact.workflowId, patch);
        workflowRevision = workflowApiRevision(updated) ?? workflowRevision;
      }
      if (body.activate === true && !active) {
        const result = await workflowClient.workflow.activateWorkflow(artifact.workflowId) as any;
        active = result?.active !== false;
      } else if (body.activate === false && active) {
        await workflowClient.workflow.deactivateWorkflow(artifact.workflowId);
        active = false;
      }
    } catch (error) {
      mutationError = error;
    }

    if (mutationError) {
      const tier1Rollback = await restoreTier1Workflow(workflowClient, artifact.workflowId, live);
      if (!tier1Rollback) {
        // Never clear the pending/failed blocker when Tier-1 state is unknown.
        await markArtifactSyncFailed(client, id, pendingRevision, 'Tier-1 mutation failed and rollback failed');
        compensationFailure({
          stage: 'mutation',
          tier1Rollback: false,
          baseRestore: 'skipped',
          pendingRevision,
        });
      }
      const baseRestore = await restoreArtifactSnapshot(client, id, artifact, pendingRevision);
      if (!baseRestore) {
        await markArtifactSyncFailed(client, id, pendingRevision, 'Tier-1 mutation was rolled back but Base rollback failed');
        compensationFailure({
          stage: 'mutation',
          tier1Rollback: true,
          baseRestore: false,
          pendingRevision,
        });
      }
      if (mutationError instanceof SynapseOneError) workflowError(mutationError);
      throw mutationError;
    }

    const next: WorkflowArtifactRecord = {
      ...artifact,
      name,
      updatedBy: principal.subject,
      updatedAt: new Date().toISOString(),
      revision: pendingRevision,
      workflowRevision,
      active,
      nodes: deployedDefinition.nodes,
      connections: deployedDefinition.connections,
      settings: deployedDefinition.settings,
      checksum: deployedChecksum,
      portableChecksum,
      credentialBindings,
      credentialRedactions: scrubbed?.redactions ?? artifact.credentialRedactions,
      versionCount: artifact.versionCount + 1,
      syncState: 'ready',
      versionHistoryStatus: 'pending',
      managedBy: 'technical',
      ...protectedArtifact(nextSettings),
    };
    delete next.syncError;
    delete next.versionHistoryError;
    delete next.pendingRevision;
    delete next.pendingChecksum;
    delete next.pendingUpdatedAt;
    if (description) next.description = description;
    else delete next.description;

    try {
      const saved = await client.base.updateDocument(ARTIFACT_COLLECTION, id, {
        data: next as unknown as Record<string, unknown>,
        ifVersion: pendingVersion,
      });
      const historyOk = await saveRevision(client, next);
      const marked = await markVersionHistory(
        client, id, next.revision, saved.version,
        historyOk ? 'complete' : 'incomplete',
        historyOk ? undefined : 'revision snapshot write failed',
      );
      await recordAudit(client, config, {
        actor: principal.subject,
        tenant: principal.tenantKey,
        action: 'workflow_artifact.update',
        correlationId: correlationIdOf(req),
        details: {
          id,
          revision: next.revision,
          redactions: next.credentialRedactions.length,
          graphChanged,
          forcedDrift: live.checksum !== artifact.checksum,
          versionHistory: marked?.status ?? 'pending',
        },
      });
      res.json({
        ...artifactResponse(next, marked?.version ?? saved.version),
        versionHistoryStatus: marked?.status ?? 'pending',
      });
    } catch (error) {
      // The Tier-1 graph changed but Base could not finalize. Roll Tier-1 back
      // to the captured graph and restore the prior artifact snapshot. If the
      // Tier-1 rollback fails, keep the artifact blocked (never ready).
      const tier1Rollback = await restoreTier1Workflow(workflowClient, artifact.workflowId, live);
      if (!tier1Rollback) {
        await markArtifactSyncFailed(
          client, id, pendingRevision,
          'Tier-1 update succeeded but rollback failed after Base finalisation failed',
        );
        compensationFailure({
          stage: 'finalize',
          tier1Rollback: false,
          baseRestore: 'skipped',
          pendingRevision,
        });
      }
      const baseRestore = await restoreArtifactSnapshot(client, id, artifact, pendingRevision);
      if (!baseRestore) {
        await markArtifactSyncFailed(
          client, id, pendingRevision,
          'Tier-1 update was rolled back but Base rollback failed',
        );
        compensationFailure({ stage: 'finalize', tier1Rollback: true, baseRestore: false, pendingRevision });
      }
      if (error instanceof SynapseOneError && error.status === 409) {
        throw apiError(409, 'version_conflict', 'the workflow artifact was modified by another request');
      }
      throw apiError(503, 'dependency_unavailable', 'the artifact could not be finalised; the Tier-1 workflow was rolled back', {
        stage: 'finalize',
      });
    }
  }));

  // ---- reconcile (explicit recovery: snapshot live Tier-1 into Base) ----
  app.post(`${base}/:id/reconcile`, handler(async (req, res) => {
    const { caller, principal, client } = await writeContext(req, config);
    const id = artifactId(req.params.id);
    const document = await loadArtifact(client, id);
    const artifact = loadAccessible(document, principal);
    if (!canMutate(artifact, principal)) {
      throw apiError(403, 'forbidden', 'only the artifact owner or a DX administrator may reconcile this artifact');
    }
    const workflowClient = await artifactWorkflowClient(config, caller, artifact);
    const body = parsePlainObject(req.body || {}, 'body', 16 * 1024);
    const requestedVersion = expectedVersion(req, body);
    const live = await readLiveWorkflow(workflowClient, artifact.workflowId);
    const scrubbed = scrubWorkflowDefinition(live.definition);
    const checksum = workflowGraphChecksum(scrubbed.definition);
    let portableChecksum = artifact.portableChecksum;
    try {
      portableChecksum = workflowGraphChecksum(exportCredentialRefs(scrubbed.definition, artifact.credentialBindings));
    } catch {
      // A live credential id without a DX binding must not be fabricated into a
      // portable ref; export stays fail-closed until the artifact is reimported.
      portableChecksum = undefined;
    }
    if (checksum === artifact.checksum && syncStateOf(artifact) === 'ready') {
      if (artifact.versionHistoryStatus === 'complete') {
        res.json(artifactView(document));
        return;
      }
      // Graph is healthy; retry the missing revision history for the current
      // revision (recovery guarantee for a failed snapshot write).
      const historyOk = await saveRevision(client, artifact);
      const marked = await markVersionHistory(
        client, id, artifact.revision, document.version,
        historyOk ? 'complete' : 'incomplete',
        historyOk ? undefined : 'revision snapshot retry failed',
      );
      res.json({
        ...artifactResponse(artifact, marked?.version ?? document.version),
        versionHistoryStatus: marked?.status ?? 'pending',
      });
      return;
    }
    const next: WorkflowArtifactRecord = {
      ...artifact,
      updatedBy: principal.subject,
      updatedAt: new Date().toISOString(),
      revision: artifact.revision + 1,
      workflowRevision: live.revision ?? artifact.workflowRevision,
      active: live.active,
      nodes: scrubbed.definition.nodes,
      connections: scrubbed.definition.connections,
      settings: scrubbed.definition.settings,
      checksum,
      ...(portableChecksum ? { portableChecksum } : {}),
      credentialRedactions: scrubbed.redactions,
      versionCount: artifact.versionCount + 1,
      syncState: 'ready',
      versionHistoryStatus: 'pending',
      managedBy: artifact.managedBy || 'user',
      ...protectedArtifact(scrubbed.definition.settings),
    };
    delete next.syncError;
    delete next.versionHistoryError;
    delete next.pendingRevision;
    delete next.pendingChecksum;
    delete next.pendingUpdatedAt;
    if (!portableChecksum) delete next.portableChecksum;
    try {
      const saved = await client.base.updateDocument(ARTIFACT_COLLECTION, id, {
        data: next as unknown as Record<string, unknown>,
        ifVersion: requestedVersion ?? document.version,
      });
      const historyOk = await saveRevision(client, next);
      const marked = await markVersionHistory(
        client, id, next.revision, saved.version,
        historyOk ? 'complete' : 'incomplete',
        historyOk ? undefined : 'revision snapshot write failed',
      );
      await recordAudit(client, config, {
        actor: principal.subject,
        tenant: principal.tenantKey,
        action: 'workflow_artifact.reconcile',
        correlationId: correlationIdOf(req),
        details: {
          id,
          revision: next.revision,
          previousState: syncStateOf(artifact),
          checksum,
          versionHistory: marked?.status ?? 'pending',
        },
      });
      res.json({
        ...artifactResponse(next, marked?.version ?? saved.version),
        versionHistoryStatus: marked?.status ?? 'pending',
      });
    } catch (error) {
      if (error instanceof SynapseOneError && error.status === 409) {
        throw apiError(409, 'version_conflict', 'the workflow artifact was modified by another request');
      }
      throw error;
    }
  }));

  // ---- versions ----
  app.get(`${base}/:id/versions`, handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const id = artifactId(req.params.id);
    const document = await loadArtifact(client, id);
    loadAccessible(document, principal);
    const result = await queryDocuments<WorkflowArtifactVersionRecord>(client, VERSION_COLLECTION, {
      where: { artifactId: id },
      orderBy: { field: 'revision', direction: 'desc' },
      limit: 100,
      offset: 0,
    });
    res.json({
      items: result.items.map((item) => ({
        revision: item.data.revision,
        ...(item.data.workflowRevision !== undefined ? { workflowRevision: item.data.workflowRevision } : {}),
        checksum: item.data.checksum,
        createdBy: item.data.createdBy,
        createdAt: item.data.createdAt,
        nodeCount: item.data.nodes.length,
        redactions: item.data.credentialRedactions.length,
      })),
      total: result.total,
    });
  }));

  app.get(`${base}/:id/versions/:revision`, handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const id = artifactId(req.params.id);
    const revision = Number(req.params.revision);
    if (!Number.isInteger(revision) || revision < 1) throw apiError(400, 'invalid_request', 'revision must be a positive integer');
    const document = await loadArtifact(client, id);
    loadAccessible(document, principal);
    const snapshot = await getDocumentOrNull<WorkflowArtifactVersionRecord>(
      client,
      VERSION_COLLECTION,
      `${id}:${revision}`,
    );
    if (!snapshot || snapshot.data.artifactId !== id || snapshot.data.tenant !== document.data.tenant) {
      throw apiError(404, 'not_found', 'workflow artifact revision not found');
    }
    res.json({ ...snapshot.data, version: snapshot.version });
  }));

  // ---- export ----
  app.get(`${base}/:id/export`, handler(async (req, res) => {
    const { caller, principal, client } = await authenticatedReadContext(req, config);
    const id = artifactId(req.params.id);
    const document = await loadArtifact(client, id);
    const artifact = loadAccessible(document, principal);
    const workflowClient = await artifactWorkflowClient(config, caller, artifact);

    let workflow: any;
    try {
      workflow = await workflowClient.workflow.getWorkflow(artifact.workflowId);
    } catch (error) {
      workflowError(error);
    }
    if (!workflow || !Array.isArray(workflow.nodes)) {
      throw apiError(503, 'tier1_capability_unavailable', 'Tier-1 returned no workflow definition', {
        dependency: 'synapseone-workflow',
      });
    }
    // Tier-1 is authoritative here; validate defensively but allow larger
    // graphs than a new import so an existing workflow is never unexportable.
    const live = extractDefinitionFromWorkflow(workflow, 500);
    const scrubbed = scrubWorkflowDefinition(live);
    const deployedChecksum = workflowGraphChecksum(scrubbed.definition);
    const portableDefinition = exportCredentialRefs(scrubbed.definition, artifact.credentialBindings);
    const portableChecksum = workflowGraphChecksum(portableDefinition);
    const workflowRevision = workflowApiRevision(workflow);

    const payload = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      artifact: {
        name: artifact.name,
        ...(artifact.description ? { description: artifact.description } : {}),
        ...(artifact.slug ? { slug: artifact.slug } : {}),
        revision: artifact.revision,
      },
      workflow: {
        nodes: portableDefinition.nodes,
        connections: portableDefinition.connections,
        settings: portableDefinition.settings,
      },
      source: artifact.source,
      checksum: portableChecksum,
      deployedChecksum,
      portableChecksum,
      credentialBindingCount: artifact.credentialBindings?.length || 0,
      credentialRedactions: scrubbed.redactions,
      redacted: scrubbed.redactions.length > 0,
      workflowRevision: workflowRevision ?? null,
      artifactVersion: document.version,
      synchronised: deployedChecksum === artifact.checksum,
      exportedAt: new Date().toISOString(),
    };
    await recordAudit(client, config, {
      actor: principal.subject,
      tenant: principal.tenantKey,
      action: 'workflow_artifact.export',
      correlationId: correlationIdOf(req),
      details: { id, redactions: scrubbed.redactions.length, synchronised: payload.synchronised },
    });
    const download = String(req.query.download || '') === '1';
    if (download) {
      const filename = `${(artifact.slug || artifact.name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'workflow'}.${FORMAT}.json`;
      res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    }
    res.json(payload);
  }));

  // ---- execute (Tier-1 SDK only) ----
  app.post(`${base}/:id/execute`, handler(async (req, res) => {
    const { caller, principal, client } = await writeContext(req, config);
    const id = artifactId(req.params.id);
    const document = await loadArtifact(client, id);
    const artifact = loadAccessible(document, principal);
    if (!canMutate(artifact, principal)) {
      throw apiError(403, 'forbidden', 'only the artifact owner or a DX administrator may execute this artifact');
    }
    assertUsableArtifact(artifact);
    const body = parsePlainObject(req.body || {}, 'body', MAX_EXECUTE_BYTES);
    const payloadInput = body.payload !== undefined ? body.payload : (body.input !== undefined ? body.input : {});
    if (!payloadInput || typeof payloadInput !== 'object' || Array.isArray(payloadInput)) {
      badDocument('payload must be a JSON object');
    }
    const payload = jsonClone(payloadInput, 'payload', MAX_EXECUTE_BYTES) as Record<string, unknown>;
    if (artifact.credentialBindings?.length || hasCredentialNodes(artifact.nodes)) {
      await requireCredentialDestinationProtection(await requireOrgWorkflowIdentity(config, artifact.tenant));
    }
    const workflowClient = await artifactWorkflowClient(config, caller, artifact);
    res.json(await executeArtifactCore(config, caller, artifact, payload, {}, correlationIdOf(req), undefined, workflowClient));
  }));

}
