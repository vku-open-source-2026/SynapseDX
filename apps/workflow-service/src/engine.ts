/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Local workflow engine — DAG runner + sandboxed code/set/if/httpRequest.
 * Apache-2.0, dependency-free (Node vm + fetch only).
 */
import vm from 'vm';
import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { isIP } from 'net';
import { promises as dns } from 'dns';

// ---------- SSRF guard (P0-1) ----------
// Hostnames are never enough: the host string is normalized (IPv4-mapped
// IPv6, decimal/hex IPv4 through URL parsing) AND every resolved address for
// a DNS name is checked (rebinding), at run time and on every redirect hop.
const BLOCKED_EXACT_HOSTS = new Set([
  'localhost', 'metadata.google.internal',
  'iam', 'gateway', 'workflow', 'postgres', 'redis', 'n8n', 's3', 'authentik', 'minio',
]);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.svc', '.cluster.local', '.invalid'];

/** Strip URL brackets, lowercase and drop the trailing root dot. */
function stripHost(host: string): string {
  let h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h.replace(/\.$/, '');
}

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** RFC1918 + loopback + link-local (incl. cloud metadata) + CGNAT + reserved. */
function isPrivateIPv4Parts(p: number[]): boolean {
  const [a, b, c] = p;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ipv4Parts(ip);
  return !parts || isPrivateIPv4Parts(parts);
}

/** Expand the trailing dotted-quad of `::ffff:127.0.0.1` into hextets. */
function expandDottedIPv6(ip: string): string | null {
  const idx = ip.lastIndexOf(':');
  if (idx < 0) return null;
  const head = ip.slice(0, idx);
  const parts = ipv4Parts(ip.slice(idx + 1));
  if (!parts) return null;
  const h1 = (((parts[0] << 8) | parts[1]) >>> 0).toString(16);
  const h2 = (((parts[2] << 8) | parts[3]) >>> 0).toString(16);
  return `${head}:${h1}:${h2}`;
}

function ipv6Hextets(ip: string): number[] | null {
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const side = (s: string): string[] | null => {
    if (!s) return [];
    const chunks = s.split(':');
    if (chunks.some((ch) => !/^[0-9a-f]{1,4}$/i.test(ch))) return null;
    return chunks;
  };
  const head = side(parts[0]);
  const tail = parts.length === 2 ? side(parts[1]) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (parts.length === 2) {
    if (missing < 1) return null;
  } else if (head.length !== 8) {
    return null;
  }
  const all = [...head, ...new Array(Math.max(missing, 0)).fill('0'), ...tail];
  if (all.length !== 8) return null;
  return all.map((h) => parseInt(h, 16));
}

function isPrivateIPv6(raw: string): boolean {
  const ip = String(raw || '').toLowerCase();
  const normalized = ip.includes('.') ? expandDottedIPv6(ip) : ip;
  if (!normalized) return true;
  const h = ipv6Hextets(normalized);
  if (!h) return true; // unparseable IPv6 literal → block (fail closed)
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
  if (h.every((x) => x === 0)) return true; // ::
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 1) return true; // ::1
  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h0 === 0x2001 && h1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if (h0 === 0x2002) return true; // 2002::/16 6to4
  // IPv4-mapped ::ffff:a.b.c.d / ::ffff:xxxx:xxxx
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return isPrivateIPv4Parts([(h6 >> 8) & 0xff, h6 & 0xff, (h7 >> 8) & 0xff, h7 & 0xff]);
  }
  // NAT64 64:ff9b::/96 wraps an IPv4 address.
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return isPrivateIPv4Parts([(h6 >> 8) & 0xff, h6 & 0xff, (h7 >> 8) & 0xff, h7 & 0xff]);
  }
  // IPv4-compatible ::a.b.c.d (deprecated) and other low special ranges.
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) return true;
  return false;
}

/** True when the hostname is a literal private/reserved IP or a known
 *  internal-only DNS name. Exported for tests. */
export function isBlockedHost(host: string): boolean {
  const h = stripHost(host);
  if (!h) return true;
  const kind = isIP(h);
  if (kind === 4) return isPrivateIPv4(h);
  if (kind === 6) return isPrivateIPv6(h);
  if (BLOCKED_EXACT_HOSTS.has(h)) return true;
  if (h === 'metadata.google.internal' || h.endsWith('.metadata.google.internal')) return true;
  return BLOCKED_SUFFIXES.some((s) => h === s.slice(1) || h.endsWith(s));
}

export function isBlockedUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  if (u.username || u.password) return true;
  // P0-1: deliberate self-call allowlist. Operators who need workflows to
  // call SynapseDX itself (e.g. http://gateway:8080/v1/orgs) set
  // SYNAPSEDX_SELF_BASE_URLS="http://gateway:8080,http://iam:4001" — exact
  // origin match only, read dynamically so tests can scope it per case.
  if (isAllowedSelfUrl(u)) return false;
  return isBlockedHost(u.hostname);
}

/** Resolve every A/AAAA record for a DNS name (injectable for tests). */
export type HostResolver = (host: string) => Promise<string[]>;

async function defaultResolveHost(host: string): Promise<string[]> {
  const recs = await dns.lookup(host, { all: true });
  return recs.map((r) => r.address);
}

/** Runtime SSRF check: sync host guard + DNS resolution of the hostname.
 *  Throws when the URL (or any address it resolves to) is private/reserved.
 *  Unresolvable names are allowed through — fetch would fail on them too,
 *  and this keeps the guard deterministic for mocked/offline tests. */
export async function assertUrlAllowed(raw: string, resolveHost: HostResolver = defaultResolveHost): Promise<void> {
  if (isBlockedUrl(raw)) throw new Error(`blocked internal URL (${String(raw).slice(0, 120)})`);
  let u: URL;
  try { u = new URL(String(raw)); } catch { throw new Error(`invalid URL (${String(raw).slice(0, 120)})`); }
  if (isAllowedSelfUrl(u)) return;
  const host = stripHost(u.hostname);
  if (isIP(host)) return; // literal checked by isBlockedUrl above
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    return; // NXDOMAIN/offline: fetch will fail the same way
  }
  for (const a of addresses) {
    const ip = stripHost(a);
    if (isIP(ip) === 0 || isBlockedHost(ip)) {
      throw new Error(`blocked internal URL (${host} resolved to ${ip})`);
    }
  }
}

/** Exact-origin allowlist for first-party calls (P0-1). */
export function selfAllowlist(): string[] {
  return String(process.env.SYNAPSEDX_SELF_BASE_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowedSelfUrl(u: URL): boolean {
  const origin = `${u.protocol}//${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ''}`;
  for (const entry of selfAllowlist()) {
    try {
      const a = new URL(entry);
      const aOrigin = `${a.protocol}//${a.hostname.toLowerCase()}${a.port ? `:${a.port}` : ''}`;
      if (origin === aOrigin) return true;
    } catch { /* ignore malformed entries */ }
  }
  return false;
}

export interface EngineNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, any>;
  [k: string]: any;
}

export interface ConnectionEdge {
  node: string;
  type?: string;
  index?: number;
  /** Auxiliary socket: "tools" or "model" (not part of the execution DAG). */
  targetPort?: 'tools' | 'model';
}
export type Connections = Record<string, { main?: Array<Array<ConnectionEdge>> }>;

export interface NodeRun {
  node: string;
  type: string;
  status: 'success' | 'error' | 'skipped';
  input: any;
  output: any;
  error?: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  attempts?: number;
}

export interface RunResult {
  status: 'success' | 'error';
  output: any;
  nodeRuns: NodeRun[];
  error?: string;
  /** With settings.onError=continue: errors that were absorbed per node. */
  partialErrors?: string[];
}

/** Caller principal threaded into runs (P0-2). */
export interface RunPrincipal {
  sub: string;
  org?: string;
  account?: string;
  kind?: string;
}

/** Resolves a first-party SynapseDX call (wired by index.ts to IAM + the
 *  local store; tests inject fakes). Runs as the run principal. */
export interface SynapseDXCall {
  (resource: string, operation: string, args: Record<string, any>, principal?: RunPrincipal | null): Promise<any>;
}

/** Resolves a credentialId to usable secret material (P0-4). Wired by
 *  index.ts to the credentials store; tests inject fakes. */
export interface CredentialResolver {
  (credentialId: string): Promise<{ kind: string; secret: string } | null>;
}

export interface RunOpts {
  triggeredBy?: string;
  timeoutMs?: number;
  principal?: RunPrincipal | null;
  credentialResolver?: CredentialResolver;
  synapsedxCall?: SynapseDXCall;
}

/** Audit actor for an execution: workflow:<id> principal:<sub|anonymous> (P0-2). */
export function actorFor(workflowId: string, principal?: RunPrincipal | null): string {
  const sub = principal?.sub && String(principal.sub).slice(0, 128) || 'anonymous';
  return `workflow:${workflowId} principal:${sub}`;
}

export function isWebhookType(type: unknown): boolean {
  return type === 'webhook' || type === 'n8n-nodes-base.webhook' || type === 'synapsedx.webhook';
}
export function isCronType(type: unknown): boolean {
  return type === 'cron' || type === 'n8n-nodes-base.cron' || type === 'synapsedx.cron';
}
export function isManualTriggerType(type: unknown): boolean {
  return type === 'manualTrigger' || type === 'n8n-nodes-base.manualTrigger' || type === 'synapsedx.manualTrigger';
}
export function isTriggerType(type: unknown): boolean {
  return isWebhookType(type) || isCronType(type) || isManualTriggerType(type);
}
export function isCodeType(type: unknown): boolean {
  return type === 'code' || type === 'n8n-nodes-base.code' || type === 'synapsedx.code';
}
export function isHttpRequestType(type: unknown): boolean {
  return type === 'httpRequest' || type === 'n8n-nodes-base.httpRequest' || type === 'synapsedx.httpRequest';
}
export function isSetType(type: unknown): boolean {
  return type === 'set' || type === 'n8n-nodes-base.set' || type === 'synapsedx.set';
}
export function isIfType(type: unknown): boolean {
  return type === 'if' || type === 'n8n-nodes-base.if' || type === 'synapsedx.if';
}
export function isDecisionType(type: unknown): boolean {
  return (
    type === 'decision' ||
    type === 'decision.route' ||
    type === 'synapseflow.decision' ||
    type === 'synapsedx.decision' ||
    type === 'n8n-nodes-base.decision'
  );
}
export function isAiAgentType(type: unknown): boolean {
  return (
    type === 'ai.agent' ||
    type === 'synapseflow.aiAgent' ||
    type === 'synapsedx.aiAgent' ||
    type === 'agent' ||
    type === 'n8n-nodes-base.aiAgent'
  );
}
export function isModelType(type: unknown): boolean {
  return type === 'synapseflow.model' || type === 'synapsedx.model';
}
export function isBranchingType(type: unknown): boolean {
  return isIfType(type) || isDecisionType(type);
}
export function isNoOpType(type: unknown): boolean {
  return type === 'noOp' || type === 'n8n-nodes-base.noOp' || type === 'synapsedx.noOp';
}

/** First-party service node types (split per service in the editor). */
export const INTEGRATION_NODE_TYPES: Record<string, { resource: string; label: string }> = {
  'synapsedx.iam': { resource: 'iam', label: 'Synapse IAM' },
  'synapsedx.base': { resource: 'base', label: 'SynapseBase' },
  'synapsedx.faststore': { resource: 'faststore', label: 'Faststore' },
  'synapsedx.queue': { resource: 'queue', label: 'SynapseQueue' },
  'synapsedx.lds': { resource: 'lds', label: 'SynapseLDS' },
  'synapsedx.inference': { resource: 'inference', label: 'Synapse Inference' },
  'synapsedx.flow': { resource: 'flow', label: 'SynapseFlow' },
};
export function isIntegrationType(type: unknown): boolean {
  return type === 'synapsedx.api' || (typeof type === 'string' && INTEGRATION_NODE_TYPES[type] !== undefined);
}

/** Auxiliary sockets never participate in execution. */
export function isAuxEdge(e: ConnectionEdge | null | undefined): boolean {
  if (!e) return false;
  return e.targetPort === 'tools' || e.targetPort === 'model' || e.type === 'tools' || e.type === 'model';
}
export function edgeTargetPort(e: ConnectionEdge | null | undefined): 'tools' | 'model' | null {
  if (!e) return null;
  if (e.targetPort === 'tools' || e.targetPort === 'model') return e.targetPort;
  if (e.type === 'tools' || e.type === 'model') return e.type;
  return null;
}

const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.manualTrigger',
  'webhook',
  'cron',
  'manualTrigger',
  'synapsedx.webhook',
  'synapsedx.cron',
  'synapsedx.manualTrigger',
]);

const MAX_CODE_BYTES = 50 * 1024;
const MAX_OUTPUT_BYTES = 500 * 1024;
const CODE_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 15000;
const MAX_HTTP_TIMEOUT_MS = 30000;
const MAX_RETRY_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retrySpec(parameters: any): { attempts: number; delayMs: number } {
  const spec = parameters?.retry;
  if (!spec || typeof spec !== 'object') return { attempts: 1, delayMs: 0 };
  const attempts = Math.min(Math.max(Math.floor(Number(spec.attempts) || 1), 1), MAX_RETRY_ATTEMPTS);
  const delayMs = Math.min(Math.max(Number(spec.delayMs) || 200, 0), 5000);
  return { attempts, delayMs };
}

function safeJsonSize(v: any): number {
  try {
    return Buffer.byteLength(JSON.stringify(v ?? null), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function clone<T>(v: T): T {
  if (v === undefined) return v;
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return v;
  }
}

/** Execution branches only — tool/model socket edges are configuration, not flow. */
export function outgoingBranches(from: string, connections: Connections): Array<Array<ConnectionEdge>> {
  const g = connections?.[from];
  const main = g?.main;
  if (!Array.isArray(main)) return [];
  return main.map((branch) =>
    Array.isArray(branch) ? branch.filter((e) => e && typeof e.node === 'string' && !isAuxEdge(e)) : [],
  );
}

export function outgoingFlat(from: string, connections: Connections): string[] {
  const out: string[] = [];
  for (const branch of outgoingBranches(from, connections)) {
    for (const e of branch) out.push(e.node);
  }
  return out;
}

/** All auxiliary edges (tools/model) keyed by source. */
export function auxiliaryEdges(connections: Connections): Array<{ from: string; to: string; port: 'tools' | 'model' }> {
  const out: Array<{ from: string; to: string; port: 'tools' | 'model' }> = [];
  for (const [from, g] of Object.entries(connections || {})) {
    for (const branch of (g as any)?.main || []) {
      for (const e of Array.isArray(branch) ? branch : []) {
        const port = edgeTargetPort(e);
        if (e?.node && port) out.push({ from, to: e.node, port });
      }
    }
  }
  return out;
}

/** Sources wired into tools/model sockets. These nodes are configuration-only:
 *  they are not entry points and do not need a flow path. */
export function auxiliarySourceNames(connections: Connections): Set<string> {
  const out = new Set<string>();
  for (const e of auxiliaryEdges(connections)) out.add(e.from);
  return out;
}

/** Node names wired into an agent's Tools socket (node-as-tool). */
export function toolSourceNames(connections: Connections, agentName: string): string[] {
  const out: string[] = [];
  for (const e of auxiliaryEdges(connections)) {
    if (e.port === 'tools' && e.to === agentName && !out.includes(e.from)) out.push(e.from);
  }
  return out;
}

/** Source node wired into an agent's Model socket, if any. */
export function modelSourceName(connections: Connections, agentName: string): string | null {
  for (const e of auxiliaryEdges(connections)) {
    if (e.port === 'model' && e.to === agentName) return e.from;
  }
  return null;
}

function incomingMap(nodes: EngineNode[], connections: Connections): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const n of nodes) m.set(n.name, new Set());
  for (const [from, g] of Object.entries(connections || {})) {
    for (const branch of (g as any)?.main || []) {
      for (const e of Array.isArray(branch) ? branch : []) {
        if (e?.node && !isAuxEdge(e) && m.has(e.node)) m.get(e.node)!.add(from);
      }
    }
  }
  return m;
}

export function detectCycle(nodes: EngineNode[], connections: Connections): string | null {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.name, WHITE);
  const stack: string[] = [];
  function dfs(u: string): string | null {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of outgoingFlat(u, connections)) {
      if (!byName.has(v)) continue;
      if (color.get(v) === GRAY) {
        const cyc = [...stack, v].join(' -> ');
        return `cycle detected: ${cyc}`;
      }
      if (color.get(v) === WHITE) {
        const r = dfs(v);
        if (r) return r;
      }
    }
    stack.pop();
    color.set(u, BLACK);
    return null;
  }
  for (const n of nodes) {
    if (color.get(n.name) === WHITE) {
      const r = dfs(n.name);
      if (r) return r;
    }
  }
  return null;
}

export function entryNodes(nodes: EngineNode[], connections: Connections): string[] {
  const triggers = nodes.filter((n) => TRIGGER_TYPES.has(n.type)).map((n) => n.name);
  if (triggers.length) return triggers;
  const incoming = incomingMap(nodes, connections);
  const aux = auxiliarySourceNames(connections);
  const orphans = nodes
    .filter((n) => (incoming.get(n.name)?.size || 0) === 0 && !aux.has(n.name))
    .map((n) => n.name);
  if (orphans.length) return orphans;
  const fallback = nodes.filter((n) => !aux.has(n.name));
  return fallback.length ? [fallback[0].name] : [];
}

// ---------- param helpers ----------

// ---------- isolated JS evaluation (P0-1 hardening) ----------
// `node:vm` is not a security boundary on its own — so we never hand host
// intrinsics/functions (Object, Math, console, data objects…) to the
// context. The context is created with a null-prototype global and
// codeGeneration disabled; input data is injected *inside* the context via
// JSON so user code only ever touches context-native values. Code nodes get
// an additional layer: a separate process (see sandbox-runner.ts).

function safeJsonString(v: any): string {
  try {
    const s = JSON.stringify(v ?? null);
    return s === undefined ? 'null' : s;
  } catch {
    return 'null';
  }
}

function isolatedContext(dataJson: string, nowIso: string): vm.Context {
  const ctx = vm.createContext(Object.create(null) as any, {
    codeGeneration: { strings: false, wasm: false },
  } as any);
  const boot = [
    'globalThis.__logs = [];',
    // console is implemented *inside* the context (never a host function —
    // host callables would expose the host Function constructor to user code).
    'globalThis.console = (() => {'
      + ' const fmt = (a) => Array.prototype.map.call(a, (x) => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch (e) { return String(x); } }).join(" ");'
      + ' const push = function () { globalThis.__logs.push(fmt(arguments)); };'
      + ' return { log: push, info: push, warn: push, error: push };'
      + ' })();',
    `globalThis.$json = JSON.parse(${JSON.stringify(dataJson)});`,
    'globalThis.$input = globalThis.$json;',
    'globalThis.input = globalThis.$json;',
    `globalThis.$now = ${JSON.stringify(nowIso)};`,
  ].join('\n');
  new vm.Script(boot).runInContext(ctx);
  return ctx;
}

/** Host-safe copy of a value produced inside a vm context: primitives pass
 *  through unchanged, objects/arrays are JSON round-tripped so callers never
 *  hold context-realm objects (prototype checks, deepEqual, serialization). */
function hostClone(v: any): any {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== 'object') return v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return undefined;
  }
}

function resolveExpression(expr: string, input: any): any {
  // Evaluate a JS expression string with $input/$json in scope (used by if/code helpers).
  const code = String(expr || '');
  try {
    const ctx = isolatedContext(safeJsonString(clone(input)), new Date().toISOString());
    const script = new vm.Script(`result = (${code})`);
    script.runInContext(ctx, { timeout: 1000 } as any);
    return hostClone((ctx as any).result);
  } catch {
    return undefined;
  }
}

function stripBraces(s: string): string {
  let t = String(s || '').trim();
  // n8n style: "={{ $json.x }}" or "{{ $json.x }}"
  t = t.replace(/^=\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
  t = t.replace(/^\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
  t = t.replace(/^=\s*/, '');
  return t;
}

function toValue(v: any, input: any): any {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (/^=\{\{[\s\S]*\}\}$/.test(t) || /^\{\{[\s\S]*\}\}$/.test(t)) {
    return resolveExpression(stripBraces(t), input);
  }
  // Inline interpolation: "Hello {{ $json.name }}" / "customer:={{ $json.id }}".
  // The editor writes this form into prompts, URLs, cache keys and messages.
  if (/\{\{[\s\S]*?\}\}/.test(t)) {
    const template = t.startsWith('=') ? t.slice(1) : t;
    return template.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (_m, expr) => {
      const r = resolveExpression(String(expr), input);
      if (r === undefined || r === null) return '';
      return typeof r === 'object' ? JSON.stringify(r) : String(r);
    });
  }
  if (t.startsWith('=') && t.length > 1) {
    const r = resolveExpression(stripBraces(t), input);
    return r === undefined ? v : r;
  }
  return v;
}

// ---------- node executors ----------

async function execTrigger(_node: EngineNode, input: any): Promise<any> {
  return clone(input);
}

async function execNoOp(_node: EngineNode, input: any): Promise<any> {
  return clone(input);
}

function execSet(node: EngineNode, input: any): any {
  const p = node.parameters || {};
  const base = input && typeof input === 'object' && !Array.isArray(input) ? clone(input) : { value: clone(input) };
  // n8n Set v3: { assignments: { assignments: [{name, value, type}] } } or { assignments: [...] }
  const tryAssignments = (a: any): Record<string, any> | null => {
    const list = Array.isArray(a) ? a : a?.assignments;
    if (!Array.isArray(list)) return null;
    const out: Record<string, any> = {};
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const k = item.name ?? item.key ?? item.id;
      if (typeof k !== 'string' || !k) continue;
      out[k] = toValue(item.value, input);
    }
    return out;
  };
  // 1. assignments shapes
  for (const cand of [p.assignments, p.values?.assignments]) {
    const r = tryAssignments(cand);
    if (r) return { ...base, ...r };
  }
  // 2. values object: { values: { a: 1 } } or { values: [{name,value}] }
  if (p.values && typeof p.values === 'object' && !Array.isArray(p.values)) {
    const vals: Record<string, any> = {};
    for (const [k, v] of Object.entries(p.values)) {
      if (k === 'assignments') continue;
      vals[k] = toValue(v, input);
    }
    if (Object.keys(vals).length) return { ...base, ...vals };
  }
  if (Array.isArray((p as any).values)) {
    const r = tryAssignments((p as any).values);
    if (r) return { ...base, ...r };
  }
  // 3. fields / columns legacy
  for (const key of ['fields', 'columns', 'mappings']) {
    const r = tryAssignments((p as any)[key]);
    if (r) return { ...base, ...r };
  }
  // 4. flat params (everything except known meta keys) as assignments
  const META = new Set(['keepOnlySet', 'options', 'include', 'includeOtherFields', 'mode', 'duplicateItem']);
  const flat: Record<string, any> = {};
  for (const [k, v] of Object.entries(p)) {
    if (META.has(k)) continue;
    flat[k] = toValue(v, input);
  }
  if (Object.keys(flat).length) {
    if (p.keepOnlySet) return flat;
    return { ...base, ...flat };
  }
  return base;
}

function compareValues(op: string, left: any, right: any): boolean {
  switch (op) {
    case 'equals': case 'equal': case '==': case '===': return left === right;
    case 'notEquals': case 'notEqual': case '!=': case '!==': return left !== right;
    case 'contains': return typeof left === 'string' && typeof right === 'string' ? left.includes(right) : Array.isArray(left) ? left.includes(right) : false;
    case 'notContains': return !(typeof left === 'string' && typeof right === 'string' ? left.includes(right) : Array.isArray(left) ? left.includes(right) : false);
    case 'startsWith': return typeof left === 'string' && typeof right === 'string' ? left.startsWith(right) : false;
    case 'endsWith': return typeof left === 'string' && typeof right === 'string' ? left.endsWith(right) : false;
    case 'larger': case 'gt': case '>': return Number(left) > Number(right);
    case 'largerEqual': case 'gte': case '>=': return Number(left) >= Number(right);
    case 'smaller': case 'lt': case '<': return Number(left) < Number(right);
    case 'smallerEqual': case 'lte': case '<=': return Number(left) <= Number(right);
    case 'isEmpty': return left === undefined || left === null || left === '' || (Array.isArray(left) && !left.length);
    case 'isNotEmpty': return !(left === undefined || left === null || left === '' || (Array.isArray(left) && !left.length));
    case 'isTrue': case 'true': return left === true;
    case 'isFalse': case 'false': return left === false;
    default: return !!left;
  }
}

function execIfCondition(node: EngineNode, input: any): boolean {
  const p = node.parameters || {};
  // 1. direct JS condition string
  for (const key of ['condition', 'expression', 'code', 'jsCode']) {
    if (typeof p[key] === 'string' && p[key].trim()) {
      const expr = stripBraces(p[key]);
      const r = resolveExpression(expr, input);
      if (typeof r === 'boolean') return r;
      if (r !== undefined) return !!r;
    }
  }
  // 2. simple value1/operation/value2
  if (p.value1 !== undefined || p.value2 !== undefined || p.operation) {
    const left = toValue(p.value1 ?? p.leftValue, input);
    const right = toValue(p.value2 ?? p.rightValue, input);
    return compareValues(String(p.operation || p.operator || 'equals'), left, right);
  }
  // 3. n8n conditions structure
  const conds = (p.conditions as any)?.conditions || p.conditions;
  if (Array.isArray(conds) && conds.length) {
    const combinator = String((p.conditions as any)?.combinator || p.combinator || 'and').toLowerCase();
    const results = conds.map((c: any) => {
      if (!c || typeof c !== 'object') return false;
      const left = toValue(c.leftValue ?? c.value1 ?? c.left, input);
      const right = toValue(c.rightValue ?? c.value2 ?? c.right, input);
      return compareValues(String(c.operator?.type || c.operator || c.operation || 'equals'), left, right);
    });
    return combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
  }
  // 4. boolean flag
  if (typeof p.value === 'boolean') return p.value;
  if (typeof p.boolean === 'boolean') return p.boolean;
  // 5. fallback: truthy input
  if (typeof input === 'boolean') return input;
  if (input && typeof input === 'object') {
    if (typeof (input as any).ok === 'boolean') return (input as any).ok;
    if (typeof (input as any).success === 'boolean') return (input as any).success;
    if (typeof (input as any).condition === 'boolean') return (input as any).condition;
  }
  return !!input;
}

export async function execDecisionNode(
  node: EngineNode,
  input: any,
  ctx?: { principal?: RunPrincipal | null; synapsedxCall?: SynapseDXCall }
): Promise<{ output: any; branch: number }> {
  const p = node.parameters || {};
  let text = '';
  if (p.input) {
    const resolved = toValue(p.input, input);
    text = typeof resolved === 'string' ? resolved : JSON.stringify(resolved ?? '');
  } else if (input && typeof input === 'object') {
    text = input.text || input.message || input.prompt || input.content || input.query || JSON.stringify(input);
  } else {
    text = String(input ?? '');
  }

  let routesList: string[] = [];
  let choicesMap: Record<string, string> = {};

  const addRoute = (name: any, description: any) => {
    const n = String(name ?? '').trim();
    if (!n || routesList.includes(n)) return;
    routesList.push(n);
    choicesMap[n] = String(description ?? n) || n;
  };
  const readRoutes = (value: any) => {
    if (Array.isArray(value)) {
      for (const c of value) {
        if (c && typeof c === 'object') addRoute(c.name ?? c.route ?? c.value, c.description ?? c.desc);
        else addRoute(c, c);
      }
      return true;
    }
    if (value && typeof value === 'object') {
      for (const [name, description] of Object.entries(value)) addRoute(name, description);
      return true;
    }
    return false;
  };

  if (!readRoutes(p.choices) && !readRoutes(p.routes)) {
    addRoute('route_0', 'Option 0');
    addRoute('route_1', 'Option 1');
  }

  const fallbackRaw = Number(p.fallbackBranch);
  const fallbackBranch = Number.isFinite(fallbackRaw) && fallbackRaw >= 0 && fallbackRaw < routesList.length
    ? Math.floor(fallbackRaw)
    : 0;
  const minConfidence = Math.min(Math.max(Number(p.minConfidence) || 0, 0), 1);

  let bestChoice = routesList[0] || 'default';
  let confidence = 0.95;
  let probabilities: Record<string, number> = {};

  try {
    if (ctx?.synapsedxCall) {
      const res = await ctx.synapsedxCall(
        'inference',
        'route',
        { input: text, choices: choicesMap, instruction: p.instruction },
        ctx.principal
      );
      if (res && res.best_choice) {
        bestChoice = String(res.best_choice);
        const c = Number(res.confidence);
        confidence = Number.isFinite(c) ? c : 0.95;
        probabilities = res.probabilities || {};
      }
    } else {
      const INF_URL = (process.env.INFERENCE_SERVICE_URL || 'http://localhost:4008').replace(/\/$/, '');
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 8000);
      try {
        const resp = await fetch(`${INF_URL}/v1/inference/decision/route`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: text, choices: choicesMap, instruction: p.instruction }),
          signal: ctl.signal,
        });
        if (resp.ok) {
          const res: any = await resp.json();
          bestChoice = String(res.best_choice || routesList[0]);
          const c = Number(res.confidence);
          confidence = Number.isFinite(c) ? c : 0.95;
          probabilities = res.probabilities || {};
        }
      } finally {
        clearTimeout(to);
      }
    }
  } catch {
    // Deterministic keyword matching fallback
    const lower = text.toLowerCase();
    for (const r of routesList) {
      if (lower.includes(r.toLowerCase())) {
        bestChoice = r;
        break;
      }
    }
  }

  // The SLM can return an unknown route or a low-confidence answer: fail over
  // to the configured fallback route instead of silently picking branch 0.
  let usedFallback = false;
  if (!routesList.includes(bestChoice) || confidence < minConfidence) {
    usedFallback = true;
    bestChoice = routesList[fallbackBranch] || routesList[0] || 'default';
  }
  let branchIndex = routesList.indexOf(bestChoice);
  if (branchIndex < 0) branchIndex = fallbackBranch;

  const output = {
    ...(input && typeof input === 'object' ? clone(input) : { value: input }),
    decision: {
      choice: bestChoice,
      route: bestChoice,
      confidence,
      probabilities,
      branch: branchIndex,
      branchIndex,
      fallback: usedFallback,
      fallbackBranch,
      minConfidence,
      routes: routesList,
      input: text.slice(0, 500),
    },
  };

  return { output, branch: branchIndex };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const want = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === want);
}

async function execHttp(node: EngineNode, input: any, ctx?: { principal?: RunPrincipal | null; credentialResolver?: CredentialResolver }): Promise<any> {
  const p = node.parameters || {};
  let url = String(p.url ?? p.uri ?? '');
  // support "={{ $json.url }}" templating
  if (/^\s*=?\{\{/.test(url)) url = String(toValue(url, input) ?? '');
  if (!url) throw new Error('httpRequest: missing url');
  try {
    await assertUrlAllowed(url);
  } catch (e: any) {
    throw new Error(`httpRequest: ${e?.message || e}`);
  }
  const method = String(p.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw new Error(`httpRequest: unsupported method ${method}`);
  const timeoutMs = Math.min(Math.max(Number(p.timeoutMs) || HTTP_TIMEOUT_MS, 1000), MAX_HTTP_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  if (p.headers && typeof p.headers === 'object' && !Array.isArray(p.headers)) {
    for (const [k, v] of Object.entries(p.headers)) headers[k] = String(toValue(v, input));
  } else if ((p.headerParameters as any)?.parameters && Array.isArray((p.headerParameters as any).parameters)) {
    for (const h of (p.headerParameters as any).parameters) {
      if (h?.name) headers[String(h.name)] = String(toValue(h.value, input));
    }
  }
  // P0-4/P1-16: credential-backed auth — the node stores only a credentialId,
  // the secret is resolved server-side and never lands in nodeRuns or params.
  const authCfg = (p.auth && typeof p.auth === 'object' ? p.auth : null) as any;
  const credentialId = authCfg?.credentialId || (typeof p.credentialId === 'string' ? p.credentialId : null);
  if (credentialId) {
    if (!ctx?.credentialResolver) throw new Error('httpRequest: auth.credentialId needs a credentialResolver (server wiring)');
    const cred = await ctx.credentialResolver(credentialId);
    if (!cred) throw new Error(`httpRequest: unknown credential '${String(credentialId).slice(0, 32)}'`);
    const secret = cred.secret;
    const kind = String(cred.kind || 'bearer');
    if (kind === 'bearer') {
      if (!hasHeader(headers, 'authorization')) headers['Authorization'] = `Bearer ${secret}`;
    } else if (kind === 'api-key') {
      const name = typeof authCfg?.header === 'string' && authCfg.header ? authCfg.header : 'X-API-Key';
      if (!hasHeader(headers, name)) headers[name] = secret;
    } else if (kind === 'basic') {
      let user = '', pass = secret;
      try {
        const parsed = JSON.parse(secret);
        if (parsed && typeof parsed === 'object') { user = String(parsed.username ?? ''); pass = String(parsed.password ?? secret); }
      } catch { /* raw secret as password with empty user */ }
      if (!hasHeader(headers, 'authorization')) headers['Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    } else if (kind === 'hmac') {
      const name = typeof authCfg?.header === 'string' && authCfg.header ? authCfg.header : 'X-Signature';
      const crypto = require('crypto');
      const sig = crypto.createHmac('sha256', secret).update(`${method}\n${url}`).digest('hex');
      if (!hasHeader(headers, name)) headers[name] = sig;
    } else {
      throw new Error(`httpRequest: unsupported credential kind '${kind}'`);
    }
  }
  // P0-3: propagate the run principal downstream on first-party calls so the
  // receiving service can authorize (never override explicit headers).
  try {
    const u = new URL(url);
    if (ctx?.principal?.sub && isAllowedSelfUrl(u)) {
      if (!hasHeader(headers, 'x-synapsedx-kind')) headers['X-SynapseDX-Kind'] = String(ctx.principal.kind || 'user');
      if (!hasHeader(headers, 'x-synapsedx-user')) headers['X-SynapseDX-User'] = String(ctx.principal.sub);
      if (ctx.principal.org && !hasHeader(headers, 'x-synapsedx-org')) headers['X-SynapseDX-Org'] = String(ctx.principal.org);
      if (ctx.principal.account && !hasHeader(headers, 'x-synapsedx-account')) headers['X-SynapseDX-Account'] = String(ctx.principal.account);
    }
  } catch { /* url already validated above */ }
  let body: string | undefined;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  if (hasBody) {
    if (p.body !== undefined) {
      const b = toValue(p.body, input);
      body = typeof b === 'string' ? b : JSON.stringify(b ?? {});
    } else if (p.jsonBody !== undefined) {
      const b = toValue(p.jsonBody, input);
      body = typeof b === 'string' ? b : JSON.stringify(b ?? {});
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    } else if (p.sendBody && p.bodyParameters) {
      body = JSON.stringify(toValue(p.bodyParameters, input) ?? {});
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
    // No implicit input forwarding: a body is sent only when the node
    // explicitly configures one (m3). GET/HEAD never send a body.
    if (body && Buffer.byteLength(body, 'utf8') > 200 * 1024) throw new Error('httpRequest: body exceeds 200KB');
  }
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // Manual redirect chain (B3): fetch's default follower would happily
    // bounce a public URL onto 169.254.169.254 — every hop is re-checked.
    let curUrl = url;
    let curMethod = method;
    let curBody: string | undefined = body;
    const MAX_HOPS = 5;
    for (let hop = 0; ; hop++) {
      if (hop > MAX_HOPS) throw new Error(`httpRequest: too many redirects (>${MAX_HOPS})`);
      try {
        await assertUrlAllowed(curUrl);
      } catch (e: any) {
        throw new Error(`httpRequest: ${e?.message || e}`);
      }
      const r = await fetch(curUrl, { method: curMethod, headers, body: curBody, signal: ctl.signal, redirect: 'manual' as any });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        await r.arrayBuffer().catch(() => undefined); // drain before hop
        if (!loc) throw new Error(`httpRequest: ${curMethod} ${curUrl} -> ${r.status} (redirect without location)`);
        let next: string;
        try {
          next = new URL(loc, curUrl).toString();
        } catch {
          throw new Error('httpRequest: redirect has invalid location');
        }
        try {
          await assertUrlAllowed(next);
        } catch (e: any) {
          throw new Error(`httpRequest: redirect ${e?.message || e}`);
        }
        curUrl = next;
        // 301/302/303 downgrade to GET without body (fetch semantics).
        if (r.status === 303 || ((r.status === 301 || r.status === 302) && curMethod === 'POST')) {
          curMethod = 'GET';
          curBody = undefined;
        }
        continue;
      }
      const text = await r.text();
      let parsed: any = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      if (!r.ok) throw new Error(`httpRequest: ${curMethod} ${curUrl} -> ${r.status}`);
      const out = { statusCode: r.status, body: parsed };
      if (safeJsonSize(out) > MAX_OUTPUT_BYTES) throw new Error('httpRequest: response exceeds 500KB');
      return out;
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`httpRequest: timed out after ${timeoutMs}ms`);
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(to);
  }
}

/** First-party SynapseDX integrations (visible as the "SynapseDX API" palette
 *  block). Strict resource→operation allowlist — no arbitrary paths, so a
 *  workflow can call SynapseDX itself without SSRF exceptions. Runs as the
 *  run principal (manual/test-run = the caller; webhook/cron = anonymous
 *  unless a runAs principal is stored — see index.ts). */
export const SYNAPSEDX_API_RESOURCES: Record<string, string[]> = {
  orgs: ['list'],
  users: ['list'],
  roles: ['list'],
  policies: ['list'],
  authorize: ['check'],
  audit: ['query'],
  keys: ['list'],
  'service-accounts': ['list'],
  workflows: ['list', 'get', 'execute'],
  executions: ['list', 'get'],
  templates: ['list', 'get'],
  lds: ['list-datasources', 'publish-record', 'get-entity'],
  base: ['list-collections', 'create-document', 'get-document', 'query-documents', 'delete-document'],
  faststore: ['get', 'set', 'incr', 'delete', 'hash-get', 'hash-set'],
  queue: ['list', 'publish', 'consume', 'ack'],
  inference: ['chat', 'embeddings', 'decision', 'route'],
};

/** Required args per resource.operation (values may be ={{ }} templates). */
const SYNAPSEDX_API_REQUIRED: Record<string, string[]> = {
  'users.list': ['orgId'],
  'roles.list': ['accountId'],
  'policies.list': ['accountId'],
  'authorize.check': ['userId', 'action', 'resource'],
  'keys.list': ['accountId'],
  'service-accounts.list': ['accountId'],
  'workflows.get': ['id'],
  'workflows.execute': ['id'],
  'executions.get': ['id'],
  'templates.get': ['name'],
  'lds.publish-record': ['datasourceId'],
  'lds.get-entity': ['datasourceId', 'entityId'],
  'base.create-document': ['collection'],
  'base.get-document': ['collection', 'id'],
  'base.query-documents': ['collection'],
  'base.delete-document': ['collection', 'id'],
  'faststore.get': ['key'],
  'faststore.set': ['key', 'value'],
  'faststore.incr': ['key'],
  'faststore.delete': ['key'],
  'faststore.hash-get': ['key'],
  'faststore.hash-set': ['key', 'values'],
  'queue.publish': ['queue', 'payload'],
  'queue.consume': ['queue'],
  'queue.ack': ['queue', 'receipt'],
  'inference.chat': ['messages'],
  'inference.embeddings': ['input'],
  'inference.decision': ['state', 'questions'],
  'inference.route': ['input', 'choices'],
};

/** Save-time validation for synapsedx.api node params. Required args must be
 *  present here too (values may be `={{ }}` templates — emptiness is
 *  re-checked at run time after resolution). */
export function validateSynapseDXParams(params: any): string | null {
  const p = params && typeof params === 'object' ? params : {};
  const resource = typeof p.resource === 'string' ? p.resource : '';
  const operation = typeof p.operation === 'string' ? p.operation : '';
  if (!resource) return "synapsedx.api: 'resource' is required (e.g. orgs, audit, workflows)";
  const ops = SYNAPSEDX_API_RESOURCES[resource];
  if (!ops) return `synapsedx.api: unknown resource '${resource.slice(0, 64)}' (see GET /v1/templates/synapsedx-self-check)`;
  if (!operation) return `synapsedx.api: 'operation' is required for '${resource}' (${ops.join(', ')})`;
  if (!ops.includes(operation)) return `synapsedx.api: unknown operation '${operation.slice(0, 64)}' for '${resource}' (${ops.join(', ')})`;
  const input = p.input && typeof p.input === 'object' && !Array.isArray(p.input) ? p.input : {};
  for (const f of SYNAPSEDX_API_REQUIRED[`${resource}.${operation}`] || []) {
    const v = (input as any)[f];
    if (v === undefined || v === null || String(v).trim() === '') {
      return `synapsedx.api: '${resource}.${operation}' needs '${f}' (put it in input or use ={{ $json.${f} }})`;
    }
  }
  return null;
}

/** Resolve a split service node (synapsedx.base, synapsedx.iam, …) to the
 *  canonical resource/operation pair understood by synapsedxCall.
 *  IAM and Flow operations are prefixed (`orgs.list`, `workflows.execute`)
 *  because they span several API resources; the other services are 1:1. */
export function resolveIntegrationCall(
  type: string,
  params: any,
): { resource: string; operation: string; input: Record<string, any> } | null {
  const service = INTEGRATION_NODE_TYPES[type];
  if (!service) return null;
  const p = params && typeof params === 'object' ? params : {};
  let operation = String(p.operation || '').trim();
  if (!operation) return null;
  let resource = service.resource;
  if (service.resource === 'iam' || service.resource === 'flow') {
    const dot = operation.indexOf('.');
    if (dot > 0) {
      resource = operation.slice(0, dot);
      operation = operation.slice(dot + 1);
    } else {
      resource = service.resource === 'iam' ? 'authorize' : 'workflows';
    }
  }
  const input = p.input && typeof p.input === 'object' && !Array.isArray(p.input) ? p.input : {};
  return { resource, operation, input };
}

/** Save-time validation for the split service nodes. */
export function validateIntegrationParams(type: string, params: any): string | null {
  const service = INTEGRATION_NODE_TYPES[type];
  if (!service) return null;
  const p = params && typeof params === 'object' ? params : {};
  const resolved = resolveIntegrationCall(type, p);
  if (!resolved) return `${type}: 'operation' is required`;
  const { resource, operation, input } = resolved;
  const ops = SYNAPSEDX_API_RESOURCES[resource];
  if (!ops) return `${type}: unknown operation '${p.operation}'`;
  if (!ops.includes(operation)) {
    return `${type}: unknown operation '${p.operation}' (${resource}: ${ops.join(', ')})`;
  }
  for (const f of SYNAPSEDX_API_REQUIRED[`${resource}.${operation}`] || []) {
    const v = (input as any)[f];
    if (v === undefined || v === null || String(v).trim() === '') {
      return `${type}: '${resource}.${operation}' needs '${f}' (put it in input or use ={{ $json.${f} }})`;
    }
  }
  return null;
}

function deepResolve(v: any, input: any, depth = 0): any {
  if (depth > 5) return v;
  if (typeof v === 'string') return toValue(v, input);
  if (Array.isArray(v)) return v.map((x) => deepResolve(x, input, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) out[k] = deepResolve(x, input, depth + 1);
    return out;
  }
  return v;
}

async function execSynapseDX(node: EngineNode, input: any, ctx?: { principal?: RunPrincipal | null; synapsedxCall?: SynapseDXCall }): Promise<any> {
  const p = node.parameters || {};
  const paramErr = validateSynapseDXParams(p);
  if (paramErr) throw new Error(paramErr);
  const resource = String(p.resource);
  const operation = String(p.operation);
  const rawArgs = p.input !== undefined ? p.input : {};
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? deepResolve(rawArgs, input) : {}) as Record<string, any>;
  const required = SYNAPSEDX_API_REQUIRED[`${resource}.${operation}`] || [];
  for (const f of required) {
    const v = (args as any)[f];
    if (v === undefined || v === null || String(v).trim() === '') {
      throw new Error(`synapsedx.api: '${resource}.${operation}' needs '${f}' (put it in input or use ={{ $json.${f} }})`);
    }
  }
  if (!ctx?.synapsedxCall) throw new Error('synapsedx.api: server does not expose a SynapseDX caller (server wiring)');
  const out = await ctx.synapsedxCall(resource, operation, args, ctx.principal);
  if (safeJsonSize(out) > MAX_OUTPUT_BYTES) throw new Error('synapsedx.api: response exceeds 500KB');
  return clone(out);
}

async function execIntegrationNode(
  node: EngineNode,
  input: any,
  ctx?: { principal?: RunPrincipal | null; synapsedxCall?: SynapseDXCall },
): Promise<any> {
  const resolved = resolveIntegrationCall(node.type, node.parameters || {});
  if (!resolved) throw new Error(`${node.type}: invalid operation configuration`);
  const paramErr = validateIntegrationParams(node.type, node.parameters || {});
  if (paramErr) throw new Error(paramErr);
  const { resource, operation } = resolved;
  const args = deepResolve(resolved.input, input) as Record<string, any>;
  for (const f of SYNAPSEDX_API_REQUIRED[`${resource}.${operation}`] || []) {
    const v = (args as any)[f];
    if (v === undefined || v === null || String(v).trim() === '') {
      throw new Error(`${node.type}: '${resource}.${operation}' needs '${f}' (put it in input or use ={{ $json.${f} }})`);
    }
  }
  if (!ctx?.synapsedxCall) throw new Error(`${node.type}: server does not expose a SynapseDX caller (server wiring)`);
  const out = await ctx.synapsedxCall(resource, operation, args, ctx.principal);
  if (safeJsonSize(out) > MAX_OUTPUT_BYTES) throw new Error(`${node.type}: response exceeds 500KB`);
  return clone(out);
}

// ---------- AI Agent tool registry ----------
// One canonical schema per tool the editor offers. Keeping definitions and
// execution in the same registry prevents the old "checkbox enabled but the
// LLM was never told about the tool" class of bugs.

export type AgentToolSpec = {
  id: string;
  description: string;
  parameters: Record<string, any>;
};

const objectSchema = (properties: Record<string, any>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: true,
});

export const AGENT_TOOL_SPECS: Record<string, AgentToolSpec> = {
  synapsebase_query: {
    id: 'synapsebase_query',
    description: 'Read or write SynapseBase JSON documents. action=query|get|create|delete.',
    parameters: objectSchema({
      action: { type: 'string', enum: ['query', 'get', 'create', 'delete'], description: 'Operation (default query)' },
      collection: { type: 'string', description: 'Collection name' },
      where: { type: 'object', description: 'Query filter object (query action)' },
      limit: { type: 'number', description: 'Max documents (query action)' },
      id: { type: 'string', description: 'Document id (get/delete)' },
      data: { type: 'object', description: 'Document body (create)' },
    }, ['collection']),
  },
  faststore_cache: {
    id: 'faststore_cache',
    description: 'Fast key-value cache. action=get|set|incr|delete|hash-get|hash-set.',
    parameters: objectSchema({
      action: { type: 'string', enum: ['get', 'set', 'incr', 'delete', 'hash-get', 'hash-set'], description: 'Operation (default get)' },
      key: { type: 'string', description: 'Cache key' },
      value: { description: 'Value for set' },
      ttlSeconds: { type: 'number', description: 'TTL for set (seconds)' },
      by: { type: 'number', description: 'Increment amount (incr)' },
      field: { type: 'string', description: 'Hash field (hash-get)' },
      values: { type: 'object', description: 'Hash values (hash-set)' },
    }, ['key']),
  },
  code_sandbox: {
    id: 'code_sandbox',
    description: 'Execute JavaScript in an isolated sandbox to transform or compute data.',
    parameters: objectSchema({
      code: { type: 'string', description: 'JavaScript body. Use $input for the current value and return a result.' },
    }, ['code']),
  },
  logic_calculator: {
    id: 'logic_calculator',
    description: 'Evaluate an arithmetic expression (numbers, parentheses, + - * / % **).',
    parameters: objectSchema({ expression: { type: 'string', description: 'Arithmetic expression' } }, ['expression']),
  },
  decision_eval: {
    id: 'decision_eval',
    description: 'Classify text into one of the supplied routes with the Decision-2.0-Eos-0.8B model.',
    parameters: objectSchema({
      input: { type: 'string', description: 'Text to classify' },
      choices: {
        oneOf: [
          { type: 'array', items: { type: 'string' } },
          { type: 'object', additionalProperties: { type: 'string' } },
        ],
        description: 'Route names (array) or route→description map',
      },
      instruction: { type: 'string', description: 'Optional routing instruction' },
    }, ['input', 'choices']),
  },
  inference_chat: {
    id: 'inference_chat',
    description: 'Ask the Synapse inference LLM a focused question and return its answer.',
    parameters: objectSchema({
      prompt: { type: 'string', description: 'Question / instruction' },
      system: { type: 'string', description: 'Optional system prompt' },
      model: { type: 'string', description: 'Optional model id' },
      messages: { type: 'array', description: 'Optional full OpenAI-style messages array' },
    }),
  },
  queue_publish: {
    id: 'queue_publish',
    description: 'SynapseQueue messaging. action=publish|list|consume|ack.',
    parameters: objectSchema({
      action: { type: 'string', enum: ['publish', 'list', 'consume', 'ack'], description: 'Operation (default publish)' },
      queue: { type: 'string', description: 'Queue name' },
      payload: { description: 'Message payload (publish)' },
      priority: { type: 'number', description: 'Optional priority' },
      delaySeconds: { type: 'number', description: 'Optional delivery delay' },
      maxMessages: { type: 'number', description: 'Batch size (consume)' },
      receipt: { type: 'string', description: 'Receipt handle (ack)' },
    }, ['queue']),
  },
  iam_check_permission: {
    id: 'iam_check_permission',
    description: 'Check whether a user is allowed to perform an action on a resource.',
    parameters: objectSchema({
      userId: { type: 'string' },
      action: { type: 'string' },
      resource: { type: 'string' },
      scope: { type: 'string', description: 'Optional org/account scope' },
    }, ['userId', 'action', 'resource']),
  },
  workflow_run: {
    id: 'workflow_run',
    description: 'Execute another SynapseFlow workflow by id (or exact name) and return its output.',
    parameters: objectSchema({
      id: { type: 'string', description: 'Workflow id (preferred)' },
      name: { type: 'string', description: 'Workflow name when id is unknown' },
      input: { type: 'object', description: 'Input JSON for the workflow' },
    }),
  },
  workflow_list: {
    id: 'workflow_list',
    description: 'List SynapseFlow workflows visible to this run.',
    parameters: objectSchema({}),
  },
  lds_publish: {
    id: 'lds_publish',
    description: 'SynapseLDS (NGSI-LD). action=list-datasources|publish-record|get-entity.',
    parameters: objectSchema({
      action: { type: 'string', enum: ['list-datasources', 'publish-record', 'get-entity'], description: 'Operation' },
      datasourceId: { type: 'string' },
      record: { type: 'object', description: 'NGSI-LD record to publish' },
      entityId: { type: 'string', description: 'Entity id (get-entity)' },
    }),
  },
  http_request: {
    id: 'http_request',
    description: 'Call an allowlisted public HTTP(S) endpoint. SSRF-guarded with DNS checks and redirect validation.',
    parameters: objectSchema({
      url: { type: 'string' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method' },
      headers: { type: 'object', description: 'Optional headers' },
      body: { description: 'Optional JSON body' },
      timeoutMs: { type: 'number', description: 'Optional timeout (max 30000)' },
    }, ['url']),
  },
};

/** Legacy tool ids kept working for workflows saved by older versions. */
export const AGENT_TOOL_ALIASES: Record<string, string[]> = {
  data_sources: ['synapsebase_query', 'faststore_cache'],
  logic_code: ['code_sandbox'],
  code_runner: ['code_sandbox'],
  decision_model: ['decision_eval'],
  faststore_get: ['faststore_cache'],
  faststore_set: ['faststore_cache'],
  synapsedx_api: ['queue_publish', 'iam_check_permission', 'workflow_run', 'workflow_list', 'lds_publish', 'inference_chat'],
};

export const DEFAULT_AGENT_TOOL_IDS = [
  'synapsebase_query', 'faststore_cache', 'code_sandbox', 'logic_calculator',
  'decision_eval', 'queue_publish', 'iam_check_permission', 'http_request',
];

/** Expand legacy ids + dedupe, preserving order. Unknown ids are ignored
 *  (they are reported by save-time validation). */
export function expandAgentToolIds(ids: unknown): string[] {
  const list = Array.isArray(ids) ? ids.map(String) : DEFAULT_AGENT_TOOL_IDS;
  const out: string[] = [];
  for (const id of list) {
    const mapped = AGENT_TOOL_ALIASES[id] || (AGENT_TOOL_SPECS[id] ? [id] : []);
    for (const tool of mapped) if (!out.includes(tool)) out.push(tool);
  }
  return out;
}

export function validateAgentToolIds(ids: unknown): string | null {
  if (ids === undefined) return null;
  if (!Array.isArray(ids)) return 'aiAgent: tools must be an array of tool ids';
  if (ids.length > 30) return 'aiAgent: at most 30 tools';
  for (const id of ids) {
    if (typeof id !== 'string') return 'aiAgent: tool ids must be strings';
    if (!AGENT_TOOL_SPECS[id] && !AGENT_TOOL_ALIASES[id]) return `aiAgent: unknown tool '${String(id).slice(0, 64)}'`;
  }
  return null;
}

function sanitizeToolName(name: string, used: Set<string>): string {
  let base = String(name || 'node')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'node';
  if (!/^[A-Za-z_]/.test(base)) base = `node_${base}`;
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) candidate = `${base}_${i++}`;
  used.add(candidate);
  return candidate;
}

function describeNodeAsTool(node: EngineNode): string {
  const p = node.parameters || {};
  const bits: string[] = [];
  if (p.operation) bits.push(`operation=${String(p.operation)}`);
  if (p.resource && p.operation) bits.unshift(`resource=${String(p.resource)}`);
  if (p.url) bits.push(`url=${String(p.url).slice(0, 120)}`);
  if (p.collection) bits.push(`collection=${String(p.collection)}`);
  if (p.queue) bits.push(`queue=${String(p.queue)}`);
  if (p.key) bits.push(`key=${String(p.key)}`);
  const detail = bits.length ? ` (${bits.join(', ')})` : '';
  return `Execute the workflow node "${node.name}" [${node.type}]${detail}. ` +
    'Pass an "input" object containing the data this node should process. ' +
    'The node runs with its saved configuration and returns its output (Decision/If nodes also report the chosen branch).';
}

export async function execAiAgentNode(
  node: EngineNode,
  data: any,
  ctx?: {
    principal?: RunPrincipal | null;
    credentialResolver?: CredentialResolver;
    synapsedxCall?: SynapseDXCall;
    /** Nodes wired into the agent's Tools socket — callable as tools. */
    toolNodes?: EngineNode[];
    /** Node wired into the agent's Model socket — overrides core/model. */
    modelNode?: EngineNode | null;
    /** Executes a canvas tool node by name with the model-supplied input. */
    runToolNode?: (name: string, input: any) => Promise<any>;
  },
): Promise<any> {
  const p = node.parameters || {};
  const mp = ctx?.modelNode?.parameters || {};
  const modelNodeIsInference = ctx?.modelNode?.type === 'synapsedx.inference';
  const core = String(mp.core || p.core || (modelNodeIsInference ? 'synapse-inference' : 'synapse-inference'));
  const model = String(
    mp.model ||
      p.model ||
      (core === 'synapse-inference' ? (process.env.AI_DEFAULT_MODEL || 'liquid/lfm-2.5-2.6b:free') : 'gpt-4o-mini'),
  );
  const baseUrl = String(
    mp.baseUrl ||
      p.baseUrl ||
      (core === 'synapse-inference' ? (process.env.INFERENCE_SERVICE_URL || 'http://inference:4008') : 'https://api.openai.com/v1'),
  ).replace(/\/$/, '');
  let apiKey = String(mp.apiKey || p.apiKey || '');
  const credentialId = mp.credentialId || p.credentialId;
  if (!apiKey && credentialId && ctx?.credentialResolver) {
    try {
      const cred = await ctx.credentialResolver(credentialId);
      if (cred) apiKey = cred.secret || (cred as any).apiKey || (cred as any).token || '';
    } catch {
      /* fall back to env key below */
    }
  }
  if (!apiKey && core === 'synapse-inference') {
    apiKey = process.env.OPENROUTER_API_KEY || '';
  }

  const systemPrompt = String(
    p.systemPrompt ||
      'You are an intelligent autonomous AI Agent in SynapseFlow. Analyze the input, use the available tools to retrieve data or take actions, and provide a helpful, accurate result.',
  );

  // p.userPrompt is the field the editor writes. The old implementation only
  // looked at p.prompt/p.message, silently ignoring what the user typed.
  const promptRaw = p.userPrompt !== undefined ? p.userPrompt : p.prompt !== undefined ? p.prompt : p.message;
  let userPrompt = '';
  if (promptRaw !== undefined) {
    const resolved = toValue(promptRaw, data);
    userPrompt = typeof resolved === 'string' ? resolved : JSON.stringify(resolved ?? '');
  } else if (data && typeof data === 'object') {
    userPrompt = data.prompt || data.message || data.text || data.query || JSON.stringify(data);
  } else {
    userPrompt = String(data ?? '');
  }

  const enabledTools = expandAgentToolIds(p.tools);
  const toolDefs: any[] = [];
  for (const id of enabledTools) {
    const spec = AGENT_TOOL_SPECS[id];
    if (!spec) continue;
    toolDefs.push({
      type: 'function',
      function: { name: spec.id, description: spec.description, parameters: spec.parameters },
    });
  }

  // Canvas tool nodes: any node connected to the purple Tools socket becomes
  // a real callable function. This is the "AI agent can use any workflow
  // logic/tool" path (Base, HTTP, Decision, Code, Queue, another workflow…).
  const nodeToolMap = new Map<string, EngineNode>();
  const usedToolNames = new Set<string>([...Object.keys(AGENT_TOOL_SPECS), ...enabledTools]);
  for (const candidate of ctx?.toolNodes || []) {
    if (!candidate || candidate.name === node.name) continue;
    const toolName = sanitizeToolName(candidate.name, usedToolNames);
    nodeToolMap.set(toolName, candidate);
    toolDefs.push({
      type: 'function',
      function: {
        name: toolName,
        description: describeNodeAsTool(candidate),
        parameters: objectSchema(
          {
            input: {
              type: 'object',
              description: 'Input JSON for the node. It is merged into the workflow data for this node execution.',
            },
          },
          [],
        ),
      },
    });
  }

  let effectiveSystemPrompt = systemPrompt;
  if (toolDefs.length > 0) {
    effectiveSystemPrompt +=
      '\n\nYou have tools available. Prefer native tool calls. If native tool calling is not supported, ' +
      'reply exactly with <tool_call>{"name":"tool_name","arguments":{...}}</tool_call> and wait for the tool result. ' +
      'Never invent tool results. When you have enough information, answer normally without a tool call.';
  }

  const messages: any[] = [
    { role: 'system', content: effectiveSystemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const maxSteps = Math.min(Math.max(Number(p.maxSteps) || 6, 1), 12);
  const actionsTaken: Array<{ tool: string; args: any; result: any; step: number }> = [];
  let finalAnswer = '';
  const t0 = Date.now();

  async function callTool(toolName: string, toolArgs: any): Promise<any> {
    if (!toolName) throw new Error('missing tool name');
    const nodeTool = nodeToolMap.get(toolName);
    if (nodeTool) {
      if (!ctx?.runToolNode) throw new Error('canvas tool execution is not wired');
      return await ctx.runToolNode(nodeTool.name, toolArgs?.input !== undefined ? toolArgs.input : toolArgs);
    }
    if (!enabledTools.includes(toolName)) {
      throw new Error(`tool '${toolName}' is not enabled for this agent`);
    }
    switch (toolName) {
      case 'logic_calculator': {
        const expr = String(toolArgs.expression || toolArgs.calc || toolArgs.code || '0').trim();
        if (expr.length > 200 || !/^[0-9+\-*/().% ]+$/.test(expr)) {
          return { expression: expr, error: 'only arithmetic expressions are allowed (max 200 chars)' };
        }
        try {
          // Sanitized arithmetic only (no identifiers/access), length-capped.
          // eslint-disable-next-line no-new-func
          const result = Function(`'use strict'; return (${expr})`)();
          return { expression: expr, result };
        } catch {
          return { expression: expr, error: 'calculation error' };
        }
      }
      case 'code_sandbox': {
        const fakeNode: EngineNode = {
          name: 'agent_code',
          type: 'code',
          parameters: { code: String(toolArgs.code || toolArgs.script || 'return $input;') },
        };
        const input = toolArgs.input !== undefined ? toolArgs.input : data;
        return await execCodeSandbox(fakeNode, input);
      }
      case 'decision_eval': {
        const choicesMap: Record<string, string> = {};
        if (Array.isArray(toolArgs.choices)) {
          for (const c of toolArgs.choices) choicesMap[String(c)] = String(c);
        } else if (toolArgs.choices && typeof toolArgs.choices === 'object') {
          for (const [k, v] of Object.entries(toolArgs.choices)) choicesMap[k] = String(v);
        }
        if (!Object.keys(choicesMap).length) return { error: 'choices are required' };
        if (ctx?.synapsedxCall) {
          return await ctx.synapsedxCall(
            'inference',
            'route',
            { input: String(toolArgs.input ?? ''), choices: choicesMap, instruction: toolArgs.instruction },
            ctx.principal,
          );
        }
        return { best_choice: Object.keys(choicesMap)[0], confidence: 0.9, probabilities: {} };
      }
      case 'synapsebase_query': {
        const action = String(toolArgs.action || 'query');
        if (!ctx?.synapsedxCall) return action === 'query' ? { items: [], total: 0 } : { ok: true };
        if (action === 'get') {
          return await ctx.synapsedxCall('base', 'get-document', { collection: toolArgs.collection, id: toolArgs.id }, ctx.principal);
        }
        if (action === 'create') {
          return await ctx.synapsedxCall(
            'base',
            'create-document',
            { collection: toolArgs.collection, id: toolArgs.id, data: toolArgs.data ?? toolArgs.value ?? {} },
            ctx.principal,
          );
        }
        if (action === 'delete') {
          return await ctx.synapsedxCall('base', 'delete-document', { collection: toolArgs.collection, id: toolArgs.id }, ctx.principal);
        }
        return await ctx.synapsedxCall(
          'base',
          'query-documents',
          {
            collection: toolArgs.collection,
            where: toolArgs.where !== undefined ? toolArgs.where : toolArgs.filter,
            orderBy: toolArgs.orderBy !== undefined ? toolArgs.orderBy : toolArgs.sort,
            limit: toolArgs.limit || 10,
          },
          ctx.principal,
        );
      }
      case 'faststore_cache': {
        const action = String(toolArgs.action || (toolArgs.value !== undefined ? 'set' : 'get'));
        if (!ctx?.synapsedxCall) return action === 'get' ? { key: toolArgs.key, value: null } : { ok: true };
        if (action === 'set') {
          return await ctx.synapsedxCall(
            'faststore',
            'set',
            { key: toolArgs.key, value: toolArgs.value, ttlSeconds: toolArgs.ttlSeconds || 3600 },
            ctx.principal,
          );
        }
        if (action === 'incr') {
          return await ctx.synapsedxCall('faststore', 'incr', { key: toolArgs.key, by: toolArgs.by || 1 }, ctx.principal);
        }
        if (action === 'delete') {
          return await ctx.synapsedxCall('faststore', 'delete', { key: toolArgs.key }, ctx.principal);
        }
        if (action === 'hash-get') {
          return await ctx.synapsedxCall('faststore', 'hash-get', { key: toolArgs.key, field: toolArgs.field }, ctx.principal);
        }
        if (action === 'hash-set') {
          return await ctx.synapsedxCall('faststore', 'hash-set', { key: toolArgs.key, values: toolArgs.values || {} }, ctx.principal);
        }
        return await ctx.synapsedxCall('faststore', 'get', { key: toolArgs.key }, ctx.principal);
      }
      case 'queue_publish': {
        const action = String(toolArgs.action || 'publish');
        if (!ctx?.synapsedxCall) return { ok: true, id: 'mock-msg' };
        if (action === 'list') return await ctx.synapsedxCall('queue', 'list', {}, ctx.principal);
        if (action === 'consume') {
          return await ctx.synapsedxCall(
            'queue',
            'consume',
            { queue: toolArgs.queue, maxMessages: toolArgs.maxMessages || 10, consumer: toolArgs.consumer || 'ai-agent' },
            ctx.principal,
          );
        }
        if (action === 'ack') {
          return await ctx.synapsedxCall('queue', 'ack', { queue: toolArgs.queue, receipt: toolArgs.receipt }, ctx.principal);
        }
        return await ctx.synapsedxCall(
          'queue',
          'publish',
          { queue: toolArgs.queue, payload: toolArgs.payload, priority: toolArgs.priority, delaySeconds: toolArgs.delaySeconds },
          ctx.principal,
        );
      }
      case 'iam_check_permission': {
        if (ctx?.synapsedxCall) {
          return await ctx.synapsedxCall(
            'authorize',
            'check',
            { userId: toolArgs.userId, action: toolArgs.action, resource: toolArgs.resource, scope: toolArgs.scope },
            ctx.principal,
          );
        }
        return { allowed: true };
      }
      case 'workflow_run': {
        if (!ctx?.synapsedxCall) throw new Error('workflow execution is not wired');
        let id = String(toolArgs.id || '');
        if (!id && toolArgs.name) {
          const listed: any = await ctx.synapsedxCall('workflows', 'list', {}, ctx.principal);
          const arr = Array.isArray(listed) ? listed : listed?.workflows || listed?.items || [];
          const hit = arr.find((w: any) => w && (w.name === toolArgs.name || w.id === toolArgs.name));
          if (!hit) throw new Error(`workflow '${String(toolArgs.name).slice(0, 80)}' not found`);
          id = String(hit.id);
        }
        if (!id) throw new Error('workflow_run needs id or name');
        return await ctx.synapsedxCall(
          'workflows',
          'execute',
          { id, input: toolArgs.input && typeof toolArgs.input === 'object' ? toolArgs.input : {} },
          ctx.principal,
        );
      }
      case 'workflow_list': {
        if (!ctx?.synapsedxCall) return [];
        return await ctx.synapsedxCall('workflows', 'list', {}, ctx.principal);
      }
      case 'lds_publish': {
        const action = String(toolArgs.action || (toolArgs.record ? 'publish-record' : 'list-datasources'));
        if (!ctx?.synapsedxCall) return action === 'list-datasources' ? [] : { ok: true };
        if (action === 'publish-record') {
          return await ctx.synapsedxCall(
            'lds',
            'publish-record',
            { datasourceId: toolArgs.datasourceId, record: toolArgs.record ?? toolArgs.payload },
            ctx.principal,
          );
        }
        if (action === 'get-entity') {
          return await ctx.synapsedxCall(
            'lds',
            'get-entity',
            { datasourceId: toolArgs.datasourceId, entityId: toolArgs.entityId },
            ctx.principal,
          );
        }
        return await ctx.synapsedxCall('lds', 'list-datasources', {}, ctx.principal);
      }
      case 'inference_chat': {
        if (!ctx?.synapsedxCall) throw new Error('inference is not wired');
        const msgs = Array.isArray(toolArgs.messages)
          ? toolArgs.messages
          : [
              ...(toolArgs.system ? [{ role: 'system', content: String(toolArgs.system) }] : []),
              { role: 'user', content: String(toolArgs.prompt || toolArgs.input || userPrompt) },
            ];
        const raw: any = await ctx.synapsedxCall(
          'inference',
          'chat',
          { messages: msgs, model: toolArgs.model || model, temperature: 0.2, max_tokens: 512 },
          ctx.principal,
        );
        const content = raw?.choices?.[0]?.message?.content ?? raw?.content ?? raw;
        return { content, raw };
      }
      case 'http_request': {
        // Reuse the workflow HTTP executor: SSRF guard, DNS/redirect checks,
        // timeouts and response-size caps all stay in one place.
        const fakeNode: EngineNode = {
          name: 'agent_http',
          type: 'httpRequest',
          parameters: {
            url: toolArgs.url,
            method: toolArgs.method || 'GET',
            headers: toolArgs.headers,
            body: toolArgs.body,
            timeoutMs: toolArgs.timeoutMs,
          },
        };
        return await execHttp(fakeNode, data, {
          principal: ctx?.principal,
          credentialResolver: ctx?.credentialResolver,
        });
      }
      default:
        throw new Error(`Agent tool '${toolName}' not recognized`);
    }
  }

  async function callLlm(msgs: any[], includeTools = true): Promise<any> {
    if (core === 'synapse-inference' && ctx?.synapsedxCall) {
      return await ctx.synapsedxCall(
        'inference',
        'chat',
        {
          messages: msgs,
          model,
          temperature: Number(p.temperature) || 0.2,
          max_tokens: Number(p.maxTokens) || 512,
          ...(includeTools && toolDefs.length > 0
            ? { tools: toolDefs, tool_choice: 'auto' }
            : {}),
        },
        ctx.principal,
      );
    }
    const url = core === 'synapse-inference' ? `${baseUrl}/v1/inference/chat/completions` : `${baseUrl}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const INTERNAL = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
    if (INTERNAL) headers['x-synapsedx-internal'] = INTERNAL;

    const payload: any = {
      model,
      messages: msgs,
      temperature: Number(p.temperature) || 0.2,
      max_tokens: Number(p.maxTokens) || 512,
    };
    if (includeTools && toolDefs.length > 0) {
      payload.tools = toolDefs;
      payload.tool_choice = 'auto';
    }

    const rawLlmTimeout = Number(process.env.INFERENCE_TIMEOUT_MS || 120000);
    const llmTimeoutMs = Math.min(Math.max(Number.isFinite(rawLlmTimeout) ? rawLlmTimeout : 120000, 1000), 300000);
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), llmTimeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`AI Agent LLM returned HTTP ${resp.status}: ${errText.slice(0, 200)}`);
      }
      return await resp.json();
    } finally {
      clearTimeout(to);
    }
  }

  for (let step = 0; step < maxSteps; step++) {
    let res: any;
    try {
      // Reserve the final turn for a written answer, and hide the tool schemas
      // entirely. Some reasoning models otherwise keep emitting their native
      // tool-call markup even when tool_choice='none'.
      const finalTurn = step === maxSteps - 1 && actionsTaken.length > 0;
      if (finalTurn) {
        messages.push({
          role: 'user',
          content: 'Provide the final remediation plan now in plain text, under 250 words, ending with a customer-safe update. Do not call, name or describe any tools.',
        });
      }
      res = await callLlm(messages, !finalTurn);
    } catch (e: any) {
      throw new Error(`AI Agent '${node.name}': ${e?.message || e}`);
    }

    const choice = res?.choices?.[0];
    const msg = choice?.message || {};
    const toolCalls = msg.tool_calls;

    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      messages.push(msg);
      for (const tc of toolCalls) {
        const fnName = tc.function?.name;
        let fnArgs: any = {};
        try {
          fnArgs = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          fnArgs = {};
        }
        let result: any;
        try {
          result = await callTool(fnName, fnArgs);
        } catch (err: any) {
          result = { error: err?.message || String(err) };
        }
        actionsTaken.push({ tool: fnName, args: fnArgs, result, step: step + 1 });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id || `call_${step}_${actionsTaken.length}`,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    const content = typeof msg.content === 'string' ? msg.content : '';
    const match =
      content.match(/<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/) ||
      content.match(/```(?:json)?\s*({[\s\S]*?"(?:name|tool)"[\s\S]*?})\s*```/);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        const toolName = parsed.name || parsed.tool;
        const toolArgs = parsed.arguments || parsed.args || parsed.input || {};
        let result: any;
        try {
          result = await callTool(toolName, toolArgs);
        } catch (err: any) {
          result = { error: err?.message || String(err) };
        }
        actionsTaken.push({ tool: toolName, args: toolArgs, result, step: step + 1 });
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: `Tool ${toolName} output: ${JSON.stringify(result)}. Continue to the final answer.` });
        continue;
      } catch {
        /* not a valid tool call — treat as final content */
      }
    }

    finalAnswer = content;
    break;
  }

  if (!finalAnswer) {
    finalAnswer = actionsTaken.length
      ? `Agent reached the maximum of ${maxSteps} steps after ${actionsTaken.length} tool call(s). Last result: ${JSON.stringify(
          actionsTaken[actionsTaken.length - 1]?.result,
        ).slice(0, 500)}`
      : `Agent reached the maximum of ${maxSteps} steps without a final answer.`;
  }

  const durationMs = Date.now() - t0;
  return {
    ...(data && typeof data === 'object' ? clone(data) : { value: data }),
    agent: {
      response: finalAnswer,
      actions_taken: actionsTaken,
      tools_used: actionsTaken.map((a) => a.tool),
      steps_count: actionsTaken.length,
      steps: actionsTaken.length,
      model,
      core,
      durationMs,
      canvas_tools: [...nodeToolMap.keys()],
    },
    response: finalAnswer,
  };
}

function getCodeSource(node: EngineNode): string | null {
  const p = node.parameters || {};
  for (const key of ['code', 'jsCode', 'js', 'functionCode', 'script']) {
    if (typeof p[key] === 'string' && p[key].length) return p[key];
  }
  return null;
}

const SANDBOX_RUNNER_FILE = path.join(__dirname, 'sandbox-runner.js');
const SANDBOX_STDIO_MAX_BYTES = 4 * 1024 * 1024;

/** Node flags for the throwaway code-sandbox process. Layer on top of the
 *  hardened vm context: a separate process with an empty env (no secrets),
 *  the permission model (no fs/child-process/worker access) and no
 *  code-generation-from-strings (kills host-Function escapes at the isolate
 *  level). Flags are feature-detected so Node 20 (--experimental-permission)
 *  and newer (--permission) both work. */
function sandboxNodeArgs(runnerFile: string): string[] {
  const flags = process.allowedNodeEnvironmentFlags;
  const args: string[] = ['--no-warnings', '--max-old-space-size=128'];
  if (flags.has('--permission')) args.push('--permission', `--allow-fs-read=${runnerFile}`);
  else if (flags.has('--experimental-permission')) args.push('--experimental-permission', `--allow-fs-read=${runnerFile}`);
  if (flags.has('--disallow-code-generation-from-strings')) args.push('--disallow-code-generation-from-strings');
  args.push(runnerFile);
  return args;
}

type SandboxOutcome = { result?: any; hasResult: boolean; logs: string[] };

/** Dev-only fallback (running from src via ts-node, where the compiled
 *  sandbox-runner.js does not exist): hardened in-process vm context. The
 *  production path is always the separate process below. */
async function execCodeSandboxInProcess(wrapped: string, dataJson: string, nowIso: string, timeoutMs: number): Promise<SandboxOutcome> {
  const ctx = isolatedContext(dataJson, nowIso);
  try {
    const script = new vm.Script(wrapped);
    const pending = script.runInContext(ctx, { timeout: timeoutMs } as any);
    const result = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms (infinite loop?)`)), timeoutMs + 250);
      Promise.resolve(pending).then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
    const logs = Array.isArray((ctx as any).__logs) ? ((ctx as any).__logs as any[]).map(String) : [];
    return { result, hasResult: result !== undefined, logs };
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (/timed out|Script execution timed out/i.test(msg)) throw new Error(`code: timed out after ${timeoutMs}ms (infinite loop?)`);
    throw new Error(`code: ${String(msg).slice(0, 500)}`);
  }
}

async function execCodeSandboxIsolated(wrapped: string, dataJson: string, nowIso: string, timeoutMs: number): Promise<SandboxOutcome> {
  const payload = JSON.stringify({ code: wrapped, inputJson: dataJson, now: nowIso, timeoutMs });
  const child = spawn(process.execPath, sandboxNodeArgs(SANDBOX_RUNNER_FILE), {
    env: {}, // secrets/database URLs never reach workflow-authored code
    cwd: os.tmpdir(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs + 1000);
  child.stdout.on('data', (d: Buffer) => {
    stdout += d.toString('utf8');
    if (stdout.length > SANDBOX_STDIO_MAX_BYTES) kill();
  });
  child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(0, 4096); });
  child.stdin.on('error', () => { /* child may die before the payload is flushed */ });
  const closed = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.on('error', (error) => resolve({ code: null, error }));
    child.on('close', (code) => resolve({ code }));
  });
  child.stdin.end(payload);
  const info = await closed;
  clearTimeout(timer);

  if (info.error) throw new Error(`code: sandbox failed to start (${info.error.message})`);
  if (timedOut) throw new Error(`code: timed out after ${timeoutMs}ms (infinite loop?)`);
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const detail = (stderr || stdout).trim().slice(0, 300);
    throw new Error(`code: sandbox exited without a result${detail ? ` (${detail})` : ''}`);
  }
  if (!parsed || parsed.ok !== true) {
    const msg = String(parsed?.error || 'unknown sandbox error');
    if (/timed out|Script execution timed out/i.test(msg)) throw new Error(`code: timed out after ${timeoutMs}ms (infinite loop?)`);
    throw new Error(`code: ${msg.slice(0, 500)}`);
  }
  const logs: string[] = Array.isArray(parsed.logs) ? parsed.logs.map(String) : [];
  let result: any;
  if (parsed.hasResult) {
    try {
      result = JSON.parse(String(parsed.resultJson));
    } catch {
      throw new Error('code: output could not be serialized to JSON');
    }
  }
  return { result, hasResult: !!parsed.hasResult, logs };
}

export async function execCodeSandbox(node: EngineNode, input: any, opts?: { timeoutMs?: number }): Promise<any> {
  const src = getCodeSource(node);
  if (src === null) throw new Error('code: missing code parameter (put JS in parameters.code)');
  if (Buffer.byteLength(src, 'utf8') > MAX_CODE_BYTES) throw new Error('code: script exceeds 50KB');
  const timeoutMs = Math.min(Math.max(Number((node.parameters as any)?.timeoutMs) || opts?.timeoutMs || CODE_TIMEOUT_MS, 1000), 15000);
  const hasReturn = /\breturn\b/.test(src);
  // Statement-looking code (loops, declarations, multi-statement) runs as a
  // body; pure expressions get an implicit `return (...)` for ergonomics.
  // Without this split, `while(true){}` would become `return (while…)` —
  // a syntax error instead of the intended timeout.
  const looksStatement = /[\n;]/.test(src) || /\b(while|for|let|const|var|function|if|else|switch|try|catch|throw|await)\b/.test(src);
  const body = hasReturn || looksStatement ? src : `return (${src});`;
  // Async wrapper so `await` works inside user code.
  const wrapped = `(async () => { ${body} })()`;
  const dataJson = safeJsonString(clone(input));
  const nowIso = new Date().toISOString();

  let outcome: SandboxOutcome;
  if (fs.existsSync(SANDBOX_RUNNER_FILE)) {
    outcome = await execCodeSandboxIsolated(wrapped, dataJson, nowIso, timeoutMs);
  } else {
    console.warn('[workflow][security] sandbox-runner.js not found (ts-node dev?) — using hardened in-process sandbox.');
    outcome = await execCodeSandboxInProcess(wrapped, dataJson, nowIso, timeoutMs);
  }
  const { result, logs } = outcome;
  if (result === undefined) return { _logs: logs.length ? logs : undefined, value: clone(input) };
  if (safeJsonSize(result) > MAX_OUTPUT_BYTES) throw new Error('code: output exceeds 500KB');
  if (logs.length) {
    // Collision-safe log attach (m3): never overwrite a user data key.
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      if (!Object.prototype.hasOwnProperty.call(result, '_logs')) {
        return { ...clone(result), _logs: logs };
      }
      return { value: clone(result), _consoleLogs: logs };
    }
    if (typeof result !== 'object' || result === null) {
      return { value: clone(result), _logs: logs };
    }
  }
  return clone(result);
}

// ---------- DAG runner ----------

export async function runWorkflow(
  definition: { nodes?: EngineNode[]; connections?: Connections; name?: string; settings?: Record<string, any> },
  input: any,
  opts?: RunOpts,
): Promise<RunResult> {
  const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
  const connections: Connections = definition?.connections && typeof definition.connections === 'object' ? definition.connections : {};
  const continueOnError = (definition as any)?.settings?.onError === 'continue';
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const startedAll = Date.now();
  const configuredTimeout = Number((definition as any)?.settings?.timeoutMs);
  const envTimeout = Number(process.env.WORKFLOW_TIMEOUT_MS || 0);
  const requestedTimeout = opts?.timeoutMs ?? (Number.isFinite(configuredTimeout) ? configuredTimeout : (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 60000));
  const timeoutMs = Math.min(Math.max(Number(requestedTimeout) || 60000, 1000), 300000);
  const nodeRuns: NodeRun[] = [];
  const partialErrors: string[] = [];

  if (!nodes.length) {
    return { status: 'success', output: clone(input ?? {}), nodeRuns };
  }

  const entries = entryNodes(nodes, connections).filter((n) => byName.has(n));
  type QueueItem = { name: string; input: any };
  const queue: QueueItem[] = entries.map((name) => ({ name, input: clone(input ?? {}) }));
  const visitCount = new Map<string, number>();
  const maxSteps = nodes.length * 3 + 10;
  let steps = 0;
  const terminalOutputs = new Map<string, any>();
  let failed: string | null = null;

  async function runNodeWithRetry(
    kind: 'http' | 'code' | 'synapsedx' | 'integration',
    node: EngineNode,
    data: any,
  ): Promise<{ output: any; attempts: number }> {
    const { attempts, delayMs } = retrySpec(node.parameters);
    let lastErr: any = null;
    for (let a = 1; a <= attempts; a++) {
      try {
        const output =
          kind === 'http'
            ? await execHttp(node, data, { principal: opts?.principal, credentialResolver: opts?.credentialResolver })
            : kind === 'synapsedx'
              ? await execSynapseDX(node, data, { principal: opts?.principal, synapsedxCall: opts?.synapsedxCall })
              : kind === 'integration'
                ? await execIntegrationNode(node, data, { principal: opts?.principal, synapsedxCall: opts?.synapsedxCall })
                : await execCodeSandbox(node, data);
        return { output, attempts: a };
      } catch (e) {
        lastErr = e;
        if (a < attempts && delayMs > 0) await sleep(delayMs);
      }
    }
    throw lastErr;
  }

  // Canvas tools are nodes wired into an agent's Tools socket. They execute
  // on demand with the model-supplied input, outside the normal DAG queue.
  let toolDepth = 0;
  async function execToolNode(name: string, toolInput: any): Promise<any> {
    if (toolDepth >= 2) throw new Error(`tool recursion limit reached while calling '${name}'`);
    const target = byName.get(name);
    if (!target) throw new Error(`tool node '${name}' not found`);
    toolDepth++;
    try {
      const r = await execNodeCore(target, toolInput);
      return {
        node: target.name,
        type: target.type,
        output: r.output,
        ...(r.branch !== undefined ? { branch: r.branch } : {}),
        ...(r.skipped ? { note: r.skipped } : {}),
      };
    } finally {
      toolDepth--;
    }
  }

  /** Execute one node body without recording a nodeRun. Used both by the DAG
   *  runner and by node-as-agent-tool calls. */
  async function execNodeCore(node: EngineNode, data: any): Promise<{ output: any; branch?: number; skipped?: string | null; attempts?: number }> {
    // P2: disabled nodes are skipped but keep data flowing (branch nodes take
    // their deterministic first branch so a run never gets stuck).
    if ((node as any).disabled === true) {
      return {
        output: clone(data),
        skipped: 'node disabled — passed through',
        branch: isIfType(node.type) || isDecisionType(node.type) ? 0 : undefined,
      };
    }
    let output: any;
    let skipped: string | null = null;
    let attempts = 1;
    const toolNodes = toolSourceNames(connections, node.name)
      .map((n) => byName.get(n))
      .filter((n): n is EngineNode => !!n);
    const modelNode = modelSourceName(connections, node.name);
    const agentCtx = {
      principal: opts?.principal,
      credentialResolver: opts?.credentialResolver,
      synapsedxCall: opts?.synapsedxCall,
      toolNodes,
      modelNode: modelNode ? byName.get(modelNode) || null : null,
      runToolNode: execToolNode,
    };
    switch (node.type) {
      case 'webhook':
      case 'n8n-nodes-base.webhook':
      case 'synapsedx.webhook':
      case 'cron':
      case 'n8n-nodes-base.cron':
      case 'synapsedx.cron':
      case 'manualTrigger':
      case 'n8n-nodes-base.manualTrigger':
      case 'synapsedx.manualTrigger':
        output = await execTrigger(node, data);
        break;
      case 'noOp':
      case 'n8n-nodes-base.noOp':
      case 'synapsedx.noOp':
        output = await execNoOp(node, data);
        break;
      case 'set':
      case 'n8n-nodes-base.set':
      case 'synapsedx.set':
        output = execSet(node, data);
        break;
      case 'if':
      case 'n8n-nodes-base.if':
      case 'synapsedx.if': {
        output = clone(data);
        return { output, branch: execIfCondition(node, output) ? 0 : 1 };
      }
      case 'httpRequest':
      case 'n8n-nodes-base.httpRequest':
      case 'synapsedx.httpRequest': {
        const r = await runNodeWithRetry('http', node, data);
        output = r.output;
        attempts = r.attempts;
        break;
      }
      case 'code':
      case 'n8n-nodes-base.code':
      case 'synapsedx.code': {
        const r = await runNodeWithRetry('code', node, data);
        output = r.output;
        attempts = r.attempts;
        break;
      }
      case 'synapsedx.api': {
        const r = await runNodeWithRetry('synapsedx', node, data);
        output = r.output;
        attempts = r.attempts;
        break;
      }
      case 'decision':
      case 'decision.route':
      case 'synapseflow.decision':
      case 'synapsedx.decision':
      case 'n8n-nodes-base.decision': {
        const dec = await execDecisionNode(node, data, {
          principal: opts?.principal,
          synapsedxCall: opts?.synapsedxCall,
        });
        return { output: dec.output, branch: dec.branch };
      }
      case 'ai.agent':
      case 'synapseflow.aiAgent':
      case 'synapsedx.aiAgent':
      case 'agent':
      case 'n8n-nodes-base.aiAgent': {
        output = await execAiAgentNode(node, data, agentCtx);
        break;
      }
      case 'synapseflow.model':
      case 'synapsedx.model':
        // Configuration-only node: pass through when it is also used in flow.
        output = clone(data);
        break;
      default: {
        if (isIntegrationType(node.type)) {
          const r = await runNodeWithRetry('integration', node, data);
          output = r.output;
          attempts = r.attempts;
          break;
        }
        // Unknown types pass data through but are marked skipped (B4) —
        // silent success hid misconfigured nodes from execution history.
        output = clone(data);
        skipped = `unknown node type '${node.type}' — passed through`;
        break;
      }
    }
    return { output, skipped, attempts };
  }

  async function execOne(node: EngineNode, data: any): Promise<{ output: any; branch?: number }> {
    const t0 = Date.now();
    const startedAt = new Date().toISOString();
    try {
      if (Date.now() - startedAll > timeoutMs) throw new Error(`workflow timed out after ${timeoutMs}ms`);
      const r = await execNodeCore(node, data);
      const finishedAt = new Date().toISOString();
      nodeRuns.push({
        node: node.name,
        type: node.type,
        status: r.skipped ? 'skipped' : 'success',
        input: clone(data),
        output: clone(r.output),
        ...(r.skipped ? { error: r.skipped } : {}),
        ...(r.attempts && r.attempts > 1 ? { attempts: r.attempts } : {}),
        durationMs: Date.now() - t0,
        startedAt,
        finishedAt,
      });
      return { output: r.output, ...(r.branch !== undefined ? { branch: r.branch } : {}) };
    } catch (e: any) {
      const finishedAt = new Date().toISOString();
      const msg = e?.message || String(e);
      nodeRuns.push({
        node: node.name,
        type: node.type,
        status: 'error',
        input: clone(data),
        output: null,
        error: String(msg).slice(0, 1000),
        durationMs: Date.now() - t0,
        startedAt,
        finishedAt,
      });
      throw e;
    }
  }

  while (queue.length) {
    if (++steps > maxSteps) {
      failed = `workflow exceeded ${maxSteps} steps (possible cycle)`;
      break;
    }
    const cur = queue.shift()!;
    const node = byName.get(cur.name);
    if (!node) continue;
    visitCount.set(cur.name, (visitCount.get(cur.name) || 0) + 1);
    if ((visitCount.get(cur.name) || 0) > 3) {
      failed = `node '${cur.name}' revisited >3 times (cycle?)`;
      break;
    }
    let execOut: any;
    let branch: number | undefined;
    try {
      const r = await execOne(node, cur.input);
      execOut = r.output;
      branch = (r as any).branch;
    } catch (e: any) {
      const msg = `${cur.name}: ${e?.message || e}`;
      // P2 dead-letter: settings.onError=continue absorbs the failure and
      // keeps the run going with an empty item (errors surface in
      // partialErrors instead of failing the whole execution).
      if (continueOnError) {
        partialErrors.push(msg);
        execOut = {};
        branch = isIfType(node.type) ? 1 : isDecisionType(node.type) ? 0 : undefined;
      } else {
        failed = msg;
        break;
      }
    }
    const branches = outgoingBranches(cur.name, connections);
    if (!branches.some((b) => b.length > 0)) {
      terminalOutputs.set(cur.name, execOut);
      continue;
    }
    if (branch !== undefined) {
      const chosen = branches[branch] || [];
      if (!chosen.length) {
        terminalOutputs.set(cur.name, execOut);
        continue;
      }
      for (const e of chosen) queue.push({ name: e.node, input: clone(execOut) });
    } else {
      for (const b of branches) {
        for (const e of b) queue.push({ name: e.node, input: clone(execOut) });
      }
    }
  }

  if (failed) {
    return { status: 'error', output: null, nodeRuns, error: failed };
  }
  let output: any;
  if (!terminalOutputs.size) {
    // No terminal (e.g. single trigger with no edges): output of last run.
    const last = nodeRuns[nodeRuns.length - 1];
    output = last ? last.output : clone(input ?? {});
  } else if (terminalOutputs.size === 1) {
    output = [...terminalOutputs.values()][0];
  } else {
    output = Object.fromEntries(terminalOutputs);
  }
  const result: RunResult = { status: 'success', output: clone(output) ?? {}, nodeRuns };
  if (partialErrors.length) result.partialErrors = partialErrors;
  return result;
}

// ---------- cron ----------

/** Timezone offset of `tz` at epoch `ms` (minutes → ms), via Intl. */
function tzOffsetMs(tz: string, ms: number): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const parts = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) === 24 ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    return asUtc - ms;
  } catch {
    return 0;
  }
}

function validTimezone(tz: unknown): boolean {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Next wall-clock fire ("M H * * *", "@daily") at epoch ms, or null. */
export function cronNextRunAt(parameters: any, fromMs?: number): number | null {
  const p = (parameters && typeof parameters === 'object' ? parameters : {}) as Record<string, any>;
  const now = typeof fromMs === 'number' ? fromMs : Date.now();
  const tz = validTimezone((p as any).timezone) ? String((p as any).timezone) : 'UTC';
  const exprs: string[] = [];
  if (typeof (p as any).cronExpression === 'string' && (p as any).cronExpression.trim()) exprs.push((p as any).cronExpression.trim());
  const rule = (p as any)?.rule?.interval;
  if (Array.isArray(rule)) {
    for (const item of rule) {
      if (String(item?.field || '').toLowerCase() === 'cron' && typeof item.cronExpression === 'string' && item.cronExpression.trim()) {
        exprs.push(item.cronExpression.trim());
      }
    }
  }
  let best: number | null = null;
  for (const e of exprs) {
    let h: number | null = null;
    let m = 0;
    if (e === '@daily') { h = 0; m = 0; }
    else {
      const mt = e.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
      if (!mt) continue;
      m = Number(mt[1]); h = Number(mt[2]);
      if (m > 59 || h > 23) continue;
    }
    // Next H:M wall-clock instant in tz after `now` (day-step, DST-safe).
    for (let day = 0; day < 3; day++) {
      const probe = now + day * 86400_000;
      const wall = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(probe));
      const [y, mo, d] = wall.split('-').map(Number);
      // Fixed-point: UTC guess minus the tz offset at the guess (2 rounds).
      let fire = Date.UTC(y, mo - 1, d, h, m);
      for (let i = 0; i < 2; i++) fire = Date.UTC(y, mo - 1, d, h, m) - tzOffsetMs(tz, fire);
      if (fire > now && (!best || fire < best)) { best = fire; break; }
    }
  }
  return best;
}

export function cronIntervalMs(node: EngineNode): number | null {
  const p = node.parameters || {};
  // explicit ms / seconds
  for (const key of ['intervalMs', 'interval', 'everyMs']) {
    const v = Number(p[key]);
    if (Number.isFinite(v) && v >= 10000) return v;
  }
  if (typeof p.cronExpression === 'string' && p.cronExpression.trim()) {
    // Minimal cron: "*/5 * * * *" (every N minutes) or "@hourly/@daily".
    const c = p.cronExpression.trim();
    if (c === '@hourly') return 3600_000;
    if (c === '@daily') return 24 * 3600_000;
    const m = c.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
    if (m) {
      const n = Math.max(1, parseInt(m[1], 10));
      return n * 60_000;
    }
    return null;
  }
  const rule = (p.rule as any)?.interval;
  if (Array.isArray(rule)) {
    for (const item of rule) {
      const field = String(item?.field || '').toLowerCase();
      if (field === 'seconds' && Number(item.secondsInterval) > 0) return Number(item.secondsInterval) * 1000;
      if (field === 'minutes' && Number(item.minutesInterval) > 0) return Number(item.minutesInterval) * 60_000;
      if (field === 'hours' && Number(item.hoursInterval) > 0) return Number(item.hoursInterval) * 3600_000;
      if (field === 'days' && Number(item.daysInterval) > 0) return Number(item.daysInterval) * 86400_000;
      if (field === 'cron' && typeof item.cronExpression === 'string') {
        const r = cronIntervalMs({ name: '', type: '', parameters: { cronExpression: item.cronExpression } } as any);
        if (r) return r;
      }
    }
  }
  // legacy flat shapes
  if (Number((p as any).hoursInterval) > 0) return Number((p as any).hoursInterval) * 3600_000;
  if (Number((p as any).minutesInterval) > 0) return Number((p as any).minutesInterval) * 60_000;
  if (Number((p as any).secondsInterval) > 0) return Number((p as any).secondsInterval) * 1000;
  return null;
}

/** Earliest wall-clock fire across a workflow's cron nodes, or null. */
export function workflowCronNextRunAt(workflow: { nodes?: EngineNode[] }, nowMs?: number): number | null {
  let best: number | null = null;
  for (const n of workflow?.nodes || []) {
    if (!isCronType((n as any)?.type)) continue;
    const t = cronNextRunAt((n as any)?.parameters, nowMs);
    if (t && (!best || t < best)) best = t;
  }
  return best;
}

export function workflowCronIntervalMs(workflow: { nodes?: EngineNode[] }): number | null {
  let best: number | null = null;
  for (const n of workflow?.nodes || []) {
    if (!isCronType((n as any)?.type)) continue;
    const ms = cronIntervalMs(n as EngineNode);
    if (ms && (!best || ms < best)) best = ms;
  }
  return best;
}

/** Validate a cron node's schedule (M8). Returns an error message or null.
 *  Sub-10s intervals and unsupported cron expressions are rejected at
 *  save/activate time instead of silently never firing. */
export function validateCronParams(parameters: any): string | null {
  const p = (parameters && typeof parameters === 'object' ? parameters : {}) as Record<string, any>;
  const raws: number[] = [];
  for (const key of ['intervalMs', 'interval', 'everyMs']) {
    const v = Number((p as any)[key]);
    if (Number.isFinite(v) && v > 0) raws.push(v);
  }
  const checkExpr = (c: string): string | null => {
    const t = String(c || '').trim();
    if (!t) return null;
    let ms: number | null = null;
    if (t === '@hourly') ms = 3600_000;
    else if (t === '@daily') ms = 24 * 3600_000;
    else {
      const m = t.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
      if (m) ms = Math.max(1, parseInt(m[1], 10)) * 60_000;
      // Wall-clock daily "M H * * *" (+ optional timezone) fires via
      // cronNextRunAt instead of a fixed interval — valid, no ms to check.
      else if (/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.test(t)) return null;
    }
    if (ms === null) {
      return `unsupported cronExpression '${t.slice(0, 32)}' (use "*/N * * * *", "M H * * *", "@hourly" or "@daily")`;
    }
    raws.push(ms);
    return null;
  };
  if (typeof (p as any).cronExpression === 'string' && (p as any).cronExpression.trim()) {
    const e = checkExpr((p as any).cronExpression);
    if (e) return `cron node: ${e}`;
  }
  const rule = (p as any)?.rule?.interval;
  if (Array.isArray(rule)) {
    for (const item of rule) {
      const field = String(item?.field || '').toLowerCase();
      if (field === 'seconds' && Number(item.secondsInterval) > 0) raws.push(Number(item.secondsInterval) * 1000);
      else if (field === 'minutes' && Number(item.minutesInterval) > 0) raws.push(Number(item.minutesInterval) * 60_000);
      else if (field === 'hours' && Number(item.hoursInterval) > 0) raws.push(Number(item.hoursInterval) * 3600_000);
      else if (field === 'days' && Number(item.daysInterval) > 0) raws.push(Number(item.daysInterval) * 86400_000);
      else if (field === 'cron' && typeof item.cronExpression === 'string' && item.cronExpression.trim()) {
        const e = checkExpr(item.cronExpression);
        if (e) return `cron node: ${e}`;
      }
    }
  }
  if (Number((p as any).hoursInterval) > 0) raws.push(Number((p as any).hoursInterval) * 3600_000);
  if (Number((p as any).minutesInterval) > 0) raws.push(Number((p as any).minutesInterval) * 60_000);
  if (Number((p as any).secondsInterval) > 0) raws.push(Number((p as any).secondsInterval) * 1000);
  for (const ms of raws) {
    if (ms < 10000) return `cron interval must be >=10s (got ${Math.round(ms / 100) / 10}s)`;
  }
  if ((p as any).timezone !== undefined && (p as any).timezone !== null && String((p as any).timezone) !== '') {
    if (!validTimezone((p as any).timezone)) return `cron node: unknown timezone '${String((p as any).timezone).slice(0, 64)}'`;
  }
  return null;
}
