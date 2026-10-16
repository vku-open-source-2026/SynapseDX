/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Local workflow engine — DAG runner + sandboxed code/set/if/httpRequest.
 * Apache-2.0, dependency-free (Node vm + fetch only).
 */
import vm from 'vm';

const BLOCKED_IP_RES = [/^169\.254\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^127\./, /^0\.0\.0\.0$/, /^\[?::1\]?$/, /^fe80:/i];
const BLOCKED_EXACT_HOSTS = new Set([
  'localhost', 'metadata.google.internal',
  'iam', 'gateway', 'workflow', 'postgres', 'redis', 'n8n', 's3', 'authentik', 'minio',
]);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.svc', '.cluster.local', '.invalid'];
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h) return true;
  if (BLOCKED_IP_RES.some((re) => re.test(h))) return true;
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
  const host = u.hostname.replace(/\.$/, '');
  return isBlockedHost(host);
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

export type Connections = Record<string, { main?: Array<Array<{ node: string; type?: string; index?: number }>> }>;

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
}

/** Audit actor for an execution: workflow:<id> principal:<sub|anonymous> (P0-2). */
export function actorFor(workflowId: string, principal?: RunPrincipal | null): string {
  const sub = principal?.sub && String(principal.sub).slice(0, 128) || 'anonymous';
  return `workflow:${workflowId} principal:${sub}`;
}

const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.manualTrigger',
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

export function outgoingBranches(from: string, connections: Connections): Array<Array<{ node: string }>> {
  const g = connections?.[from];
  const main = g?.main;
  if (!Array.isArray(main)) return [];
  return main
    .map((branch) => (Array.isArray(branch) ? branch.filter((e) => e && typeof e.node === 'string') : []))
    .filter((b) => b.length > 0);
}

export function outgoingFlat(from: string, connections: Connections): string[] {
  const out: string[] = [];
  for (const branch of outgoingBranches(from, connections)) {
    for (const e of branch) out.push(e.node);
  }
  return out;
}

function incomingMap(nodes: EngineNode[], connections: Connections): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const n of nodes) m.set(n.name, new Set());
  for (const [from, g] of Object.entries(connections || {})) {
    for (const branch of (g as any)?.main || []) {
      for (const e of Array.isArray(branch) ? branch : []) {
        if (e?.node && m.has(e.node)) m.get(e.node)!.add(from);
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
  const orphans = nodes.filter((n) => (incoming.get(n.name)?.size || 0) === 0).map((n) => n.name);
  if (orphans.length) return orphans;
  return nodes.length ? [nodes[0].name] : [];
}

// ---------- param helpers ----------

function resolveExpression(expr: string, input: any): any {
  // Evaluate a JS expression string with $input/$json in scope (used by if/code helpers).
  const code = String(expr || '');
  const sandbox: any = {
    $input: clone(input),
    $json: clone(input),
    input: clone(input),
    $now: new Date().toISOString(),
    Math, JSON, Date, Number, String, Boolean, Array, Object,
    isNaN, parseInt, parseFloat,
  };
  try {
    const script = new vm.Script(`result = (${code})`);
    const ctx = vm.createContext({ ...sandbox, result: undefined } as any, { codeGeneration: { strings: false, wasm: false } } as any);
    script.runInContext(ctx, { timeout: 1000 } as any);
    return (ctx as any).result;
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
  if (isBlockedUrl(url)) throw new Error(`httpRequest: blocked internal URL (${url.slice(0, 80)})`);
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
      if (isBlockedUrl(curUrl)) throw new Error(`httpRequest: blocked internal URL (${curUrl.slice(0, 80)})`);
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
        if (isBlockedUrl(next)) throw new Error(`httpRequest: redirect to blocked internal URL (${next.slice(0, 80)})`);
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

function getCodeSource(node: EngineNode): string | null {
  const p = node.parameters || {};
  for (const key of ['code', 'jsCode', 'js', 'functionCode', 'script']) {
    if (typeof p[key] === 'string' && p[key].length) return p[key];
  }
  return null;
}

export async function execCodeSandbox(node: EngineNode, input: any, opts?: { timeoutMs?: number }): Promise<any> {
  const src = getCodeSource(node);
  if (src === null) throw new Error('code: missing code parameter (put JS in parameters.code)');
  if (Buffer.byteLength(src, 'utf8') > MAX_CODE_BYTES) throw new Error('code: script exceeds 50KB');
  const timeoutMs = Math.min(Math.max(Number((node.parameters as any)?.timeoutMs) || opts?.timeoutMs || CODE_TIMEOUT_MS, 1000), 15000);
  const logs: string[] = [];
  const limitedConsole = {
    log: (...a: any[]) => {
      logs.push(a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' '));
    },
    info: (...a: any[]) => {
      logs.push(a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' '));
    },
    warn: (...a: any[]) => {
      logs.push(a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' '));
    },
    error: (...a: any[]) => {
      logs.push(a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' '));
    },
  };
  const hasReturn = /\breturn\b/.test(src);
  // Statement-looking code (loops, declarations, multi-statement) runs as a
  // body; pure expressions get an implicit `return (...)` for ergonomics.
  // Without this split, `while(true){}` would become `return (while…)` —
  // a syntax error instead of the intended timeout.
  const looksStatement = /[\n;]/.test(src) || /\b(while|for|let|const|var|function|if|else|switch|try|catch|throw|await)\b/.test(src);
  const body = hasReturn || looksStatement ? src : `return (${src});`;
  // Async wrapper so `await` works inside user code.
  const wrapped = `(async () => { ${body} })()`;
  const sandbox: any = {
    $input: clone(input),
    $json: clone(input),
    input: clone(input),
    $now: new Date().toISOString(),
    Math, JSON, Date, Number, String, Boolean, Array, Object,
    isNaN, parseInt, parseFloat,
    console: limitedConsole,
  };
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } } as any);
  let result: any;
  try {
    const script = new vm.Script(wrapped);
    result = await script.runInContext(ctx, { timeout: timeoutMs } as any);
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (/timed out|Script execution timed out/i.test(msg)) throw new Error(`code: timed out after ${timeoutMs}ms (infinite loop?)`);
    throw new Error(`code: ${msg.slice(0, 500)}`);
  }
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
  const timeoutMs = opts?.timeoutMs ?? 60000;
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

  async function runNodeWithRetry(kind: 'http' | 'code', node: EngineNode, data: any): Promise<{ output: any; attempts: number }> {
    const { attempts, delayMs } = retrySpec(node.parameters);
    let lastErr: any = null;
    for (let a = 1; a <= attempts; a++) {
      try {
        const output = kind === 'http'
          ? await execHttp(node, data, { principal: opts?.principal, credentialResolver: opts?.credentialResolver })
          : await execCodeSandbox(node, data);
        return { output, attempts: a };
      } catch (e) {
        lastErr = e;
        if (a < attempts && delayMs > 0) await sleep(delayMs);
      }
    }
    throw lastErr;
  }

  async function execOne(node: EngineNode, data: any): Promise<{ output: any; branch?: number }> {
    const t0 = Date.now();
    const startedAt = new Date().toISOString();
    try {
      if (Date.now() - startedAll > timeoutMs) throw new Error(`workflow timed out after ${timeoutMs}ms`);
      // P2: disabled nodes are skipped but keep the data flowing (an `if`
      // takes its default true branch so the run stays deterministic).
      if ((node as any).disabled === true) {
        const output = clone(data);
        const finishedAt = new Date().toISOString();
        nodeRuns.push({
          node: node.name, type: node.type, status: 'skipped',
          input: clone(data), output: clone(output), error: 'node disabled — passed through',
          durationMs: Date.now() - t0, startedAt, finishedAt,
        });
        return node.type === 'n8n-nodes-base.if' ? { output, branch: 0 } : { output };
      }
      let output: any;
      let skipped: string | null = null;
      let attempts = 1;
      switch (node.type) {
        case 'n8n-nodes-base.webhook':
        case 'n8n-nodes-base.cron':
        case 'n8n-nodes-base.manualTrigger':
          output = await execTrigger(node, data);
          break;
        case 'n8n-nodes-base.noOp':
          output = await execNoOp(node, data);
          break;
        case 'n8n-nodes-base.set':
          output = execSet(node, data);
          break;
        case 'n8n-nodes-base.if':
          output = clone(data);
          break;
        case 'n8n-nodes-base.httpRequest': {
          const r = await runNodeWithRetry('http', node, data);
          output = r.output;
          attempts = r.attempts;
          break;
        }
        case 'n8n-nodes-base.code': {
          const r = await runNodeWithRetry('code', node, data);
          output = r.output;
          attempts = r.attempts;
          break;
        }
        default:
          // Unknown types pass data through but are marked skipped (B4) —
          // silent success hid misconfigured nodes from execution history.
          output = clone(data);
          skipped = `unknown node type '${node.type}' — passed through`;
          break;
      }
      const finishedAt = new Date().toISOString();
      nodeRuns.push({
        node: node.name, type: node.type, status: skipped ? 'skipped' : 'success',
        input: clone(data), output: clone(output),
        ...(skipped ? { error: skipped } : {}),
        ...(attempts > 1 ? { attempts } : {}),
        durationMs: Date.now() - t0, startedAt, finishedAt,
      });
      if (node.type === 'n8n-nodes-base.if') {
        const cond = execIfCondition(node, output);
        return { output, branch: cond ? 0 : 1 };
      }
      return { output };
    } catch (e: any) {
      const finishedAt = new Date().toISOString();
      const msg = e?.message || String(e);
      nodeRuns.push({
        node: node.name, type: node.type, status: 'error',
        input: clone(data), output: null, error: String(msg).slice(0, 1000),
        durationMs: Date.now() - t0, startedAt, finishedAt,
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
        branch = node.type === 'n8n-nodes-base.if' ? 1 : undefined;
      } else {
        failed = msg;
        break;
      }
    }
    const branches = outgoingBranches(cur.name, connections);
    if (!branches.length) {
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
    if ((n as any)?.type !== 'n8n-nodes-base.cron') continue;
    const t = cronNextRunAt((n as any)?.parameters, nowMs);
    if (t && (!best || t < best)) best = t;
  }
  return best;
}

export function workflowCronIntervalMs(workflow: { nodes?: EngineNode[] }): number | null {
  let best: number | null = null;
  for (const n of workflow?.nodes || []) {
    if ((n as any)?.type !== 'n8n-nodes-base.cron') continue;
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
