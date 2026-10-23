/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * End-to-end verification of the complex SynapseBase Vector RAG Orchestrator workflow.
 */
import assert from 'node:assert/strict';
import { SynapseDXClient } from '../../sdks/sdk-js/dist/index.js';

const BASE_URL = process.env.SYNAPSEDX_BASE_URL || 'http://localhost:8080';
const WF_BASE = process.env.WORKFLOW_SERVICE_URL || 'http://localhost:4002';

console.log('--- STARTING COMPLEX SYNAPSEBASE VECTOR WORKFLOW VERIFICATION ---');
console.log(`Connecting to Gateway: ${BASE_URL}`);

const c = new SynapseDXClient({ baseUrl: BASE_URL });
const stamp = Date.now().toString(36);
const login = await c.iam.login(`vector-sre-${stamp}@acme.local`);
c.setToken(login.accessToken);

const kbCollection = `kb_rag_${stamp}`;
const webhookPath = `rag-triage-${stamp}`;

try {
  // Step 1: Create Knowledge Base Collection in SynapseBase
  console.log(`[1] Creating SynapseBase collection: ${kbCollection}...`);
  await c.base.createCollection({
    name: kbCollection,
    description: 'Enterprise Knowledge Base for Vector RAG Orchestrator',
    mapping: {
      fields: {
        title: { path: 'title', type: 'string', required: true },
        category: { path: 'category', type: 'string' },
        solution: { path: 'solution', type: 'string' },
        embedding: { path: 'embedding', type: 'vector', dimension: 384, metric: 'cosine' },
      },
    },
  });

  // Step 2: Seed KB articles with real embeddings from Synapse Inference Engine
  console.log('[2] Seeding Knowledge Base articles with semantic embeddings...');
  const ssoQuery = 'How to configure SAML and OIDC single sign-on SSO authentication for corporate identity providers';
  const articles = [
    {
      id: 'kb-sso-01',
      title: 'Configuring SAML and OIDC SSO authentication for corporate identity providers',
      category: 'iam',
      solution: 'Navigate to Admin > Identity Providers, select OIDC/SAML, paste metadata URL, and assign default role.',
      textForEmbed: ssoQuery,
    },
    {
      id: 'kb-db-02',
      title: 'Resolving PostgreSQL connection pool exhaustion and deadlocks',
      category: 'database',
      solution: 'Increase max_connections in postgresql.conf, tune PgBouncer pool_size to 50, and enable statement timeouts.',
      textForEmbed: 'Database connection pool exhausted postgres deadlock connection timeout too many clients.',
    },
    {
      id: 'kb-queue-03',
      title: 'Webhook delivery retry strategy and dead letter queue configuration',
      category: 'queue',
      solution: 'Configure maxRetries=5 with exponential backoff on queue worker; undeliverable messages automatically move to DLQ.',
      textForEmbed: 'Webhook delivery retry policy failover dead letter queue DLQ exponential backoff message delivery.',
    },
  ];

  for (const art of articles) {
    const embRes = await c.inference.embeddings(art.textForEmbed);
    const vec = embRes?.data?.[0]?.embedding;
    assert.ok(Array.isArray(vec), `Embedding failed for ${art.id}`);
    assert.equal(vec.length, 384, `Unexpected dimension for ${art.id}`);

    await c.base.createDocument(kbCollection, {
      id: art.id,
      object: {
        title: art.title,
        category: art.category,
        solution: art.solution,
        embedding: vec,
      },
    });
  }
  console.log(`Seeded ${articles.length} KB articles successfully.`);

  // Step 3: Fetch template definition and instantiate workflow
  console.log('[3] Loading template vector-rag-orchestrator...');
  const fs = await import('node:fs');
  const template = JSON.parse(fs.readFileSync('examples/workflow-templates/vector-rag-orchestrator.json', 'utf8'));
  assert.equal(template.name, 'vector-rag-orchestrator');

  // Customize template: point collection to our unique test collection and webhook path
  for (const node of template.nodes) {
    if (node.name === 'KBVectorSearch') {
      node.parameters.input.collection = kbCollection;
    }
    if (node.name === 'Intake') {
      node.parameters.path = webhookPath;
    }
    if (node.name === 'EscalateQueue') {
      node.parameters.operation = 'publish';
    }
  }

  // Step 4: Test-Run the complex DAG interactively
  console.log('[4] Verifying workflow interactive test-run (POST /v1/workflows/test-run)...');
  const testRunPayload = {
    definition: {
      nodes: template.nodes,
      connections: template.connections,
      settings: template.settings,
    },
    input: {
      query: ssoQuery,
      incidentId: `inc-sso-${stamp}`,
    },
  };
  const trRes = await fetch(`${BASE_URL}/v1/workflows/test-run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${login.accessToken}`,
    },
    body: JSON.stringify(testRunPayload),
  });
  if (!trRes.ok) {
    const errText = await trRes.text();
    console.error('Test-run error response:', trRes.status, errText);
  }
  assert.equal(trRes.status, 200, 'Test-run failed');
  const trData = await trRes.json();
  assert.equal(trData.ok, true, `Test-run not ok: ${JSON.stringify(trData)}`);
  console.log(`Test-run ok: ${trData.ok}, executionId: ${trData.executionId}`);
  const trNodeRuns = Array.isArray(trData.nodeRuns) ? trData.nodeRuns : Object.values(trData.nodeRuns || {});
  for (const r of trNodeRuns) {
    console.log(`  -> node [${r.node}]: status=${r.status}, output=${JSON.stringify(r.output)}`);
  }
  const finalSummaryRun = trNodeRuns.find((r) => r.node === 'FinalSummary') || trNodeRuns[trNodeRuns.length - 1];
  const finalSummaryOutput = finalSummaryRun?.output;
  console.log('Test-run FinalSummary output:', JSON.stringify(finalSummaryOutput, null, 2));
  assert.ok(finalSummaryOutput, 'FinalSummary node output missing');
  assert.equal(finalSummaryOutput.ok, true);
  assert.equal(finalSummaryOutput.resolutionType, 'automated_rag');
  assert.ok(finalSummaryOutput.similarity >= 0.70, `Similarity too low: ${finalSummaryOutput.similarity}`);

  // Step 5: Save and Activate Workflow in SynapseFlow repository
  console.log('[5] Saving and activating workflow...');
  const createWfRes = await fetch(`${BASE_URL}/v1/workflows`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${login.accessToken}`,
    },
    body: JSON.stringify({
      name: `RAG-Orchestrator-${stamp}`,
      description: 'Complex Vector RAG Orchestrator live instance',
      definition: {
        nodes: template.nodes,
        connections: template.connections,
        settings: template.settings,
      },
    }),
  });
  if (!createWfRes.ok) {
    const errText = await createWfRes.text();
    console.error('Workflow creation error response:', createWfRes.status, errText);
  }
  assert.equal(createWfRes.status, 201, 'Workflow creation failed');
  const createdWf = await createWfRes.json();
  const wfId = createdWf.id;
  console.log(`Created Workflow ID: ${wfId}`);

  const actRes = await fetch(`${BASE_URL}/v1/workflows/${encodeURIComponent(wfId)}/activate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.accessToken}` },
  });
  assert.equal(actRes.status, 200, 'Activation failed');
  console.log('Workflow activated successfully.');

  // Step 6: Test Case 1 - High Similarity Match -> Automated RAG Route
  console.log('[6] Test Case 1: Webhook execution with high-similarity SSO query...');
  const ssoWebhookRes = await fetch(`${WF_BASE}/webhook/${webhookPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: ssoQuery,
      incidentId: `inc-sso-live-${stamp}`,
    }),
  });
  assert.equal(ssoWebhookRes.status, 200, 'Webhook call failed');
  const ssoExec = await ssoWebhookRes.json();
  console.log(`Webhook result ok: ${ssoExec.ok}, executionId: ${ssoExec.executionId}`);
  assert.equal(ssoExec.ok, true);

  // Verify Faststore cached key created by CacheResult node
  console.log('[6.1] Verifying Faststore cache key created by workflow...');
  const cacheKey = `rag:incident:inc-sso-live-${stamp}`;
  const cachedVal = await c.faststore.get(cacheKey);
  console.log(`Cache value for ${cacheKey}:`, cachedVal);
  assert.ok(cachedVal, 'Faststore cache entry was not set');
  const rawJson = typeof cachedVal === 'string' ? cachedVal : cachedVal?.value;
  const cachedObj = JSON.parse(rawJson);
  assert.equal(cachedObj.resolutionType, 'automated_rag');
  assert.equal(cachedObj.status, 'resolved');
  assert.equal(cachedObj.matchedDocId, 'kb-sso-01');

  // Step 7: Test Case 2 - Low Similarity Query -> Escalate to Queue Route
  console.log('[7] Test Case 2: Webhook execution with completely unrelated query (should escalate to queue)...');
  const escalateWebhookRes = await fetch(`${WF_BASE}/webhook/${webhookPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'Purchase coffee machine beans and milk for kitchen pantry',
      incidentId: `inc-escalate-${stamp}`,
    }),
  });
  assert.equal(escalateWebhookRes.status, 200, 'Webhook call failed');
  const escExec = await escalateWebhookRes.json();
  console.log(`Escalation webhook result ok: ${escExec.ok}, executionId: ${escExec.executionId}`);
  assert.equal(escExec.ok, true);

  // Verify escalation cache record
  const escCacheVal = await c.faststore.get(`rag:incident:inc-escalate-${stamp}`);
  assert.ok(escCacheVal, 'Escalation cache entry was not set');
  const escRawJson = typeof escCacheVal === 'string' ? escCacheVal : escCacheVal?.value;
  const escObj = JSON.parse(escRawJson);
  console.log('Escalation cache object:', escObj);
  assert.equal(escObj.status, 'escalated');
  assert.equal(escObj.resolutionType, 'human_sre_queue');
  assert.ok(escObj.similarity < 0.50, `Expected low similarity for coffee query, got ${escObj.similarity}`);

  // Step 8: Test Case 3 - Direct SDK vector search and CLI base vector-search
  console.log('[8] Testing direct SDK vector search & CLI synapsedx base vector-search...');
  const dbQuery = 'Database connection pool exhausted postgres deadlock connection timeout too many clients.';
  const dbEmb = await c.inference.embeddings(dbQuery);
  const searchDirect = await c.base.vectorSearch(kbCollection, {
    vector: dbEmb.data[0].embedding,
    limit: 1,
    metric: 'cosine',
    as: 'object',
  });
  assert.equal(searchDirect.items.length, 1);
  assert.equal(searchDirect.items[0].id, 'kb-db-02');
  assert.ok(searchDirect.items[0].similarity >= 0.99);
  console.log(`Direct SDK vector search match: ${searchDirect.items[0].id} (similarity: ${searchDirect.items[0].similarity})`);

  // Verify CLI command directly
  const { execFileSync } = await import('node:child_process');
  const cliOutput = execFileSync(
    process.execPath,
    [
      'tools/cli/bin/synapsedx.js',
      '--base', BASE_URL,
      '--token', login.accessToken,
      '--json',
      'base', 'vector-search', kbCollection,
      '--query', ssoQuery,
      '--limit', '1',
    ],
    { encoding: 'utf8' },
  );
  const cliRes = JSON.parse(cliOutput);
  console.log('CLI vector-search output items:', cliRes.items?.length);
  assert.ok(Array.isArray(cliRes.items));
  assert.equal(cliRes.items[0].id, 'kb-sso-01');
  assert.ok(cliRes.items[0].similarity >= 0.99);
  console.log('CLI vector-search verified successfully!');

  // Step 9: Cleanup
  console.log('[9] Cleaning up test workflow and collection...');
  await fetch(`${BASE_URL}/v1/workflows/${encodeURIComponent(wfId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${login.accessToken}` },
  });
  await c.base.deleteCollection(kbCollection);
  await c.faststore.delete(cacheKey);
  await c.faststore.delete(`rag:incident:inc-escalate-${stamp}`);

  console.log('================================================================');
  console.log('🎉 COMPLEX SYNAPSEBASE VECTOR WORKFLOW VERIFICATION PASSED 100%!');
  console.log('================================================================');
} catch (err) {
  console.error('❌ VERIFICATION FAILED:', err);
  process.exit(1);
}
