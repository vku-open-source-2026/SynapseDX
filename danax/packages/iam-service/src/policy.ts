/*
 * Copyright 2026 danax Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * AWS IAM-style policy evaluation: explicit Deny wins, then Allow, default deny.
 */
import type { PolicyDoc } from './db';

function toArr(x: string | string[]): string[] {
  return Array.isArray(x) ? x : [x];
}

// minimatch-lite: supports '*' and 'prefix:*' and exact
export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return value === prefix || value.startsWith(prefix + ':') || value.startsWith(prefix);
  }
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return pattern === value;
}

export interface AuthzRequest {
  action: string;   // e.g. "workflow:Execute"
  resource: string; // e.g. "arn:danax:acme:prod:workflow:etl-nightly" or "*"
}

export type ConditionContext = Record<string, string | number | boolean | undefined>;

// AWS-style conditions (subset): StringEquals (+ IfExists variants), StringLike.
// Condition chưa thỏa → statement bị bỏ qua (không match).
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
      if (op === 'StringEquals') {
        const ok = Array.isArray(v) ? v.map(String).includes(a) : String(v) === a;
        if (!ok) return false;
      } else if (op === 'StringLike') {
        const patterns = (Array.isArray(v) ? v : [v]).map(String);
        const ok = patterns.some((p) => {
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
  return {
    Version: '2026-01-01',
    Statement: [
      { Effect: 'Allow', Action: ['workflow:Execute', 'workflow:Read'], Resource: '*' },
      { Effect: 'Deny', Action: ['iam:*', 'org:Delete'], Resource: '*' },
    ],
  };
}
