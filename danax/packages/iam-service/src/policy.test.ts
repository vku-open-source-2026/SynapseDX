/*
 * Copyright 2026 OLP Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Unit tests for AWS-style policy evaluation (pure, no DB).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicies, matchPattern, adminPolicy, workflowRunnerPolicy } from './policy';

describe('matchPattern', () => {
  it('star matches all', () => {
    assert.equal(matchPattern('*', 'workflow:Execute'), true);
  });
  it('prefix:* matches service actions', () => {
    assert.equal(matchPattern('workflow:*', 'workflow:Execute'), true);
    assert.equal(matchPattern('workflow:*', 'iam:Delete'), false);
  });
  it('exact matches only itself', () => {
    assert.equal(matchPattern('iam:Create', 'iam:Create'), true);
    assert.equal(matchPattern('iam:Create', 'iam:Delete'), false);
  });
  it('arn-style resources', () => {
    const doc = { Version: '1', Statement: [{ Effect: 'Allow' as const, Action: 'workflow:Execute', Resource: 'arn:olp:acme:prod:workflow:*' }] };
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: 'arn:olp:acme:prod:workflow:etl' }).allowed, true);
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: 'arn:olp:acme:staging:workflow:etl' }).allowed, false);
  });
});

describe('evaluatePolicies', () => {
  it('default deny with no policies', () => {
    assert.equal(evaluatePolicies([], { action: 'workflow:Execute', resource: '*' }).allowed, false);
  });
  it('allow works', () => {
    const r = evaluatePolicies([adminPolicy()], { action: 'anything:Do', resource: '*' });
    assert.equal(r.allowed, true);
  });
  it('explicit deny beats allow', () => {
    const r = evaluatePolicies([workflowRunnerPolicy('prod')], { action: 'iam:Delete', resource: '*' });
    assert.equal(r.allowed, false);
    const r2 = evaluatePolicies([workflowRunnerPolicy('prod')], { action: 'workflow:Execute', resource: '*' });
    assert.equal(r2.allowed, true);
  });
  it('deny in one doc overrides allow in another', () => {
    const allow = { Version: '1', Statement: [{ Effect: 'Allow' as const, Action: '*', Resource: '*' }] };
    const deny = { Version: '1', Statement: [{ Effect: 'Deny' as const, Action: 'org:Delete', Resource: '*' }] };
    assert.equal(evaluatePolicies([allow, deny], { action: 'org:Delete', resource: '*' }).allowed, false);
    assert.equal(evaluatePolicies([allow, deny], { action: 'org:Read', resource: '*' }).allowed, true);
  });
});

describe('conditions', () => {
  const docWith = (cond: any) => ({
    Version: '1',
    Statement: [{ Effect: 'Allow' as const, Action: 'workflow:Execute', Resource: '*', Condition: cond }],
  });
  it('StringEquals gate on org', () => {
    const doc = docWith({ StringEquals: { org: 'acme' } });
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, { org: 'acme' }).allowed, true);
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, { org: 'other' }).allowed, false);
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, {}).allowed, false);
  });
  it('StringLike wildcard on email', () => {
    const doc = docWith({ StringLike: { email: '*@acme.local' } });
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, { email: 'a@acme.local' }).allowed, true);
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, { email: 'a@evil.com' }).allowed, false);
  });
  it('IfExists skips missing keys', () => {
    const doc = docWith({ StringEqualsIfExists: { team: 'etl' } });
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, {}).allowed, true);
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, { team: 'nope' }).allowed, false);
  });
  it('unknown operator is conservative (deny)', () => {
    const doc = docWith({ IpAddress: { sourceIp: '10.0.0.0/8' } });
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, { sourceIp: '10.1.2.3' }).allowed, false);
  });
});
