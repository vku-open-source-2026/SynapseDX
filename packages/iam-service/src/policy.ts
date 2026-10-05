/*
 * Copyright 2026 OLP Contributors
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
  resource: string; // e.g. "arn:olp:acme:prod:workflow:etl-nightly" or "*"
}

export function evaluatePolicies(docs: PolicyDoc[], req: AuthzRequest): { allowed: boolean; matchedBy?: string } {
  let allowed = false;
  for (const doc of docs) {
    for (const st of doc.Statement || []) {
      const actions = toArr(st.Action);
      const resources = toArr(st.Resource);
      const actionHit = actions.some((a) => matchPattern(a, req.action));
      const resourceHit = resources.some((r) => matchPattern(r, req.resource));
      if (actionHit && resourceHit) {
        if (st.Effect === 'Deny') return { allowed: false, matchedBy: 'Deny' };
        if (st.Effect === 'Allow') allowed = true;
      }
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
