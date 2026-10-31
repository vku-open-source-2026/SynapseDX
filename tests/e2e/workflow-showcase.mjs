#!/usr/bin/env node
/*
 * End-to-end showcase for the customer-360-orchestrator template.
 *
 * Proves a single workflow can combine:
 *   webhook -> Decision (4 routes) -> Base / Faststore / IAM / LDS / Queue /
 *   Flow / AI Agent + canvas Tools/Model sockets -> fan-in -> metrics -> IF.
 *
 * The deterministic lanes run in CI. Set SHOWCASE_RUN_AI=1 (with a configured
 * inference provider) to also exercise the autonomous SRE agent lane.
 */
import assert from 'node:assert/strict';

const BASE = (process.env.SYNAPSEONE_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const EMAIL = process.env.SHOWCASE_EMAIL || 'ci@acme.local';
const ORG = process.env.SHOWCASE_ORG || 'acme';
const RUN_AI = process.env.SHOWCASE_RUN_AI === '1';
const WORKFLOW_NAME = `showcase-customer-360-${Date.now()}`;
const WEBHOOK_PATH = 'customer-360-demo';
let currentWebhookPath = WEBHOOK_PATH;

let TOKEN = '';

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${path} -> ${res.status}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

async function waitReady() {
  for (let i = 0; i < 72; i++) {
    try {
      const r = await fetch(`${BASE}/ready`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error('gateway did not become ready');
}

function byNode(exec) {
  return Object.fromEntries((exec.nodeRuns || []).map((n) => [n.node, n]));
}

async function runCase(name, payload, expectedRoute, expectedNodes, expectedTerminal, minNodes) {
  const res = await api(`/webhook/${currentWebhookPath}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  assert.equal(res.ok, true, `${name}: webhook returned ok=false (${res.error || ''})`);
  assert.ok(res.executionId, `${name}: missing executionId`);
  const exec = await api(`/v1/executions/${encodeURIComponent(res.executionId)}?includeData=true`);
  assert.equal(exec.status, 'success', `${name}: execution failed: ${exec.error || ''}`);
  const runs = byNode(exec);
  assert.ok(runs.Route, `${name}: Decision did not run`);
  assert.equal(runs.Route.output.decision.route, expectedRoute, `${name}: route`);
  assert.ok(runs.Aggregate, `${name}: Aggregate did not run`);
  assert.equal(runs.Aggregate.output.route, expectedRoute, `${name}: aggregate route`);
  assert.ok(runs.FlowCatalog, `${name}: Flow integration did not run`);
  assert.ok(runs.HasLDS, `${name}: LDS gate did not run`);
  assert.ok(runs.PublishTimeline, `${name}: LDS publish did not run`);
  assert.ok(runs.Metrics, `${name}: Faststore metrics did not run`);
  assert.ok(runs[expectedTerminal], `${name}: expected terminal ${expectedTerminal}`);
  for (const nodeName of expectedNodes) {
    assert.ok(runs[nodeName], `${name}: expected node ${nodeName}`);
    assert.equal(runs[nodeName].status, 'success', `${name}: node ${nodeName} status=${runs[nodeName].status} error=${runs[nodeName].error || ''}`);
  }
  assert.ok((exec.nodeRuns || []).length >= minNodes, `${name}: only ${(exec.nodeRuns || []).length} nodeRuns`);
  const integrations = [...new Set((exec.nodeRuns || [])
    .filter((n) => n.status === 'success' && String(n.type || '').startsWith('synapseone.'))
    .map((n) => n.type))].sort();
  console.log(`PASS ${name}: route=${expectedRoute} nodeRuns=${exec.nodeRuns.length} terminal=${expectedTerminal}`);
  console.log(`     integrations=${integrations.join(',')}`);
  return exec;
}

async function main() {
  await waitReady();
  const login = await api('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, orgSlug: ORG }),
  });
  TOKEN = login.accessToken;
  assert.ok(TOKEN, 'login did not return accessToken');
  const userId = login.user?.id;
  assert.ok(userId, 'login did not return user.id');

  // Clean up previous showcase runs so the fixed webhook path is reusable.
  try {
    const listed = await api('/v1/workflows?limit=100');
    const items = Array.isArray(listed) ? listed : (listed.data || listed.workflows || listed.items || []);
    for (const wf of items) {
      if (wf && typeof wf.name === 'string' && wf.name.startsWith('showcase-customer-360-')) {
        await api(`/v1/workflows/${encodeURIComponent(wf.id)}/deactivate`, { method: 'POST', body: '{}' }).catch(() => null);
        await api(`/v1/workflows/${encodeURIComponent(wf.id)}`, { method: 'DELETE' }).catch(() => null);
      }
    }
  } catch { /* fresh stack: nothing to clean */ }

  // Base collection: dynamic mapping keeps the demo self-contained.
  const collection = await api('/v1/base/collections', {
    method: 'POST',
    body: JSON.stringify({ name: 'customer360_events', description: 'Customer 360 showcase audit trail', mapping: { additional: true, fields: {} } }),
  }).catch((e) => {
    if (String(e.message).includes('409')) return { name: 'customer360_events' };
    throw e;
  });
  assert.equal(collection.name, 'customer360_events');
  await api('/v1/base/collections/customer360_events/documents', {
    method: 'POST',
    body: JSON.stringify({ id: 'kb-seed-status', data: { topic: 'status-page', title: 'Public status page', body: 'Use status.synapseone.space for customer updates.' } }),
  }).catch((e) => { if (!String(e.message).includes('409')) throw e; });

  // LDS datasource for the timeline side-effect.
  const lds = await api('/v1/lds/datasources', {
    method: 'POST',
    body: JSON.stringify({ name: `Customer 360 Timeline ${Date.now()}`, entityType: 'CustomerEvent', license: 'CC-BY-4.0' }),
  });
  assert.ok(lds.id, 'LDS datasource id missing');
  await api(`/v1/lds/datasources/${encodeURIComponent(lds.id)}/attributes`, {
    method: 'PUT',
    body: JSON.stringify({
      attributes: ['eventId', 'kind', 'customerId', 'route', 'query', 'amount', 'priority', 'receivedAt']
        .map((name) => ({ name, visibility: 'public' })),
    }),
  });

  const template = await api('/v1/templates/customer-360-orchestrator');
  assert.equal(template.nodes.length, 30);
  const wf = await api('/v1/workflows', {
    method: 'POST',
    body: JSON.stringify({ template: 'customer-360-orchestrator', name: WORKFLOW_NAME }),
  });
  assert.ok(wf.id, 'workflow id missing');
  const hookNode = (wf.nodes || []).find((n) => n.type && n.type.includes('webhook'));
  if (hookNode?.parameters?.path) currentWebhookPath = hookNode.parameters.path;
  await api(`/v1/workflows/${encodeURIComponent(wf.id)}/activate`, { method: 'POST', body: '{}' });
  console.log(`workflow=${wf.id} name=${wf.name || WORKFLOW_NAME} nodes=${template.nodes.length} webhook=${currentWebhookPath}`);

  const common = {
    customerId: 'cust-360',
    userId,
    datasourceId: lds.id,
    tier: 'enterprise',
  };
  const stamp = Date.now();

  await runCase('billing', {
    ...common,
    eventId: `evt-billing-${stamp}`,
    amount: 1200,
    query: 'Please refund my invoice and reverse the duplicate charge',
  }, 'billing', ['BillingCalc', 'BillingCache', 'BillingRecord', 'BillingDone', 'Escalate'], 'Escalate', 12);

  await runCase('account', {
    ...common,
    eventId: `evt-account-${stamp}`,
    amount: 0,
    query: 'I cannot login, permission denied after password reset',
  }, 'account', ['AccountAuth', 'AccountSnapshot', 'AccountRecord', 'AccountDone', 'Done'], 'Done', 13);

  await runCase('growth', {
    ...common,
    eventId: `evt-growth-${stamp}`,
    amount: 0,
    query: 'We want to upgrade and discuss pricing for our renewal',
  }, 'growth', ['GrowthPlan', 'GrowthRecord', 'GrowthDone', 'Done'], 'Done', 11);

  if (RUN_AI) {
    const aiExec = await runCase('technical-ai', {
      ...common,
      eventId: `evt-technical-${stamp}`,
      amount: 0,
      priority: 'urgent',
      query: 'Production API outage returns 502 for every request',
    }, 'technical', ['IncidentAgent', 'Escalate'], 'Escalate', 10);
    const ai = byNode(aiExec).IncidentAgent?.output?.agent;
    assert.ok(ai && ai.steps_count > 0, 'technical-ai: agent did not call any tools');
    assert.ok(typeof ai.response === 'string' && ai.response.trim(), 'technical-ai: agent returned no answer');
    assert.ok(!ai.response.startsWith('Agent reached the maximum'), 'technical-ai: agent only returned the max-steps fallback');
    assert.ok(!/<\|?tool_call/.test(ai.response), 'technical-ai: agent returned raw tool-call markup instead of an answer');
    console.log(`AI lane executed with tools=${ai.tools_used.join(',')} steps=${ai.steps_count}`);
  } else {
    console.log('SKIP technical-ai (set SHOWCASE_RUN_AI=1 with inference credentials to run it)');
  }

  const executions = await api(`/v1/executions?workflowId=${encodeURIComponent(wf.id)}&includeData=true`);
  const rows = Array.isArray(executions) ? executions : (executions.data || []);
  assert.ok(rows.length >= (RUN_AI ? 4 : 3), `expected execution history, got ${rows.length}`);
  console.log(`SHOWCASE_OK workflow=${wf.id} executions=${rows.length}`);
}

main().catch((e) => {
  console.error(`SHOWCASE_FAIL: ${e?.stack || e}`);
  process.exit(1);
});
