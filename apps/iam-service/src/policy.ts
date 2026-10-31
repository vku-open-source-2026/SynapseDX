/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * AWS IAM-style policy evaluation: explicit Deny wins, then Allow, default deny.
 */
import type { PolicyDoc } from './db';

function toArr(x: string | string[]): string[] {
  return Array.isArray(x) ? x : [x];
}

// minimatch-lite: '*' matches any sequence (including ':'), exact otherwise.
// 'prefix:*' therefore requires the ':' boundary — no over-match of 'prefixEvil'.
export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  // Bare service prefix still matches 'service:*' (legacy behavior).
  if (pattern.endsWith(':*') && value === pattern.slice(0, -2)) return true;
  // Escape regex specials except '*' (which becomes '.*'); ':' stays literal so
  // 'workflow:*' -> ^workflow:.*$ does NOT match 'workflowEvil:x'.
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  try { return re.test(value); } catch { return false; }
}

export interface AuthzRequest {
  action: string;   // e.g. "workflow:Execute"
  resource: string; // e.g. "arn:synapseone:acme:prod:workflow:etl-nightly" or "*"
}

export type ConditionContext = Record<string, string | number | boolean | undefined>;

// AWS-style conditions (subset): StringEquals (+ IfExists variants), StringLike.
// Condition chưa thỏa → statement bị bỏ qua (không match).
// ReDoS guard: StringLike patterns compile thành RegExp — giới hạn độ dài/số lượng
// để policy độc hại không thể đốt CPU mỗi lần authorize (xem validatePolicyDocument:
// cùng giới hạn áp lúc ghi; ở đây fail-closed theo hướng "không match" để 1 statement
// xấu không thể tự biến thành Allow/Deny trên input bất ngờ).
const MAX_LIKE_PATTERN_LEN = 256;
const MAX_LIKE_PATTERNS_PER_KEY = 100;

export function matchCondition(cond: any, ctx: ConditionContext): boolean {
  if (!cond || typeof cond !== 'object') return true;
  for (const [opRaw, kv] of Object.entries(cond)) {
    const ifExists = opRaw.endsWith('IfExists');
    const op = ifExists ? opRaw.slice(0, -'IfExists'.length) : opRaw;
    if (typeof kv !== 'object' || kv === null) return false;
    for (const [k, v] of Object.entries(kv as Record<string, any>)) {
      const actual = ctx[k];
      if (actual === undefined) {
        if (ifExists) continue;
        return false;
      }
      const a = String(actual);
      if (a.length > 4096) return false; // context value bất thường → không match
      if (op === 'StringEquals') {
        const ok = Array.isArray(v) ? v.map(String).includes(a) : String(v) === a;
        if (!ok) return false;
      } else if (op === 'StringLike') {
        const patterns = (Array.isArray(v) ? v : [v]).map(String);
        if (patterns.length > MAX_LIKE_PATTERNS_PER_KEY) return false;
        const ok = patterns.some((p) => {
          if (p.length > MAX_LIKE_PATTERN_LEN) return false;
          // '*' wildcard both sides-safe: escape regex specials trừ '*'
          const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
          return re.test(a);
        });
        if (!ok) return false;
      } else {
        return false; // operator lạ → conservative: không match
      }
    }
  }
  return true;
}

export function evaluatePolicies(
  docs: PolicyDoc[],
  req: AuthzRequest,
  context: ConditionContext = {},
): { allowed: boolean; matchedBy?: string } {
  let allowed = false;
  for (const doc of docs) {
    for (const st of doc.Statement || []) {
      const actions = toArr(st.Action);
      const resources = toArr(st.Resource);
      const actionHit = actions.some((a) => matchPattern(a, req.action));
      const resourceHit = resources.some((r) => matchPattern(r, req.resource));
      if (!actionHit || !resourceHit) continue;
      if (!matchCondition((st as any).Condition, context)) continue;
      if (st.Effect === 'Deny') return { allowed: false, matchedBy: 'Deny' };
      if (st.Effect === 'Allow') allowed = true;
    }
  }
  return { allowed, matchedBy: allowed ? 'Allow' : undefined };
}

// helpers to build common docs
export function adminPolicy(): PolicyDoc {
  return { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] };
}
export function readOnlyPolicy(): PolicyDoc {
  return { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: ['*:Get', '*:List', '*:Describe', '*:Read'], Resource: '*' }] };
}
export function workflowRunnerPolicy(accountSlug: string): PolicyDoc {
  const safe = /^[a-z0-9-]{1,64}$/.test(accountSlug || '') ? accountSlug : '*';
  return {
    Version: '2026-01-01',
    Statement: [
      { Effect: 'Allow', Action: ['workflow:Execute', 'workflow:Read'], Resource: safe === '*' ? '*' : `arn:synapseone:*:${safe}:*` },
      { Effect: 'Deny', Action: ['iam:*', 'org:Delete'], Resource: '*' },
    ],
  };
}

/**
 * Validate a policy document BEFORE storing/evaluating it (called by IAM on
 * createPolicy + authorize/dry-run). Returns an error message, or null when valid.
 * Caps: statements, pattern lengths, condition size — blocks stored-ReDoS and
 * oversized documents (DoS via 1mb JSON body full of statements).
 */
const MAX_STATEMENTS = 100;
const MAX_PATTERN_LEN = 512;
const MAX_CONDITION_BYTES = 8192;

export function validatePolicyDocument(doc: any): string | null {
  if (!doc || typeof doc !== 'object') return 'document must be an object';
  if (!Array.isArray((doc as any).Statement)) return 'document.Statement required (AWS IAM style)';
  const stmts = (doc as any).Statement;
  if (stmts.length === 0) return 'document.Statement must not be empty';
  if (stmts.length > MAX_STATEMENTS) return `document.Statement exceeds ${MAX_STATEMENTS} statements`;
  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i];
    if (!st || typeof st !== 'object') return `Statement[${i}] must be an object`;
    if (st.Effect !== 'Allow' && st.Effect !== 'Deny') return `Statement[${i}].Effect must be Allow|Deny`;
    for (const key of ['Action', 'Resource'] as const) {
      const arr = Array.isArray(st[key]) ? st[key] : [st[key]];
      if (arr.length === 0 || arr.length > MAX_STATEMENTS) return `Statement[${i}].${key} must have 1..${MAX_STATEMENTS} entries`;
      for (const p of arr) {
        if (typeof p !== 'string' || p.length === 0) return `Statement[${i}].${key} entries must be non-empty strings`;
        if (p.length > MAX_PATTERN_LEN) return `Statement[${i}].${key} pattern exceeds ${MAX_PATTERN_LEN} chars`;
      }
    }
    if (st.Condition !== undefined) {
      let bytes = 0;
      try {
        bytes = Buffer.byteLength(JSON.stringify(st.Condition), 'utf8');
      } catch {
        return `Statement[${i}].Condition is not JSON-serializable`;
      }
      if (bytes > MAX_CONDITION_BYTES) return `Statement[${i}].Condition exceeds ${MAX_CONDITION_BYTES} bytes`;
    }
  }
  return null;
}
