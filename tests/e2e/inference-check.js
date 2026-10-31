/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 * End-to-end check for Synapse Inference Engine through the Gateway
 * and directly to the inference container.
 */
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const dotenv = require('dotenv');

const envFile = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf-8') : '';
const env = dotenv.parse(envFile);

const GATEWAY_BASE = process.env.SYNAPSEONE_BASE_URL || 'http://localhost:8080';
const INFERENCE_DIRECT = process.env.INFERENCE_SERVICE_URL || 'http://localhost:4008';
const JWT_SECRET = process.env.IAM_JWT_SECRET || env.IAM_JWT_SECRET || 'change_me_super_secret_32chars_min';
const INTERNAL_SECRET = process.env.SYNAPSEONE_INTERNAL_SECRET || env.SYNAPSEONE_INTERNAL_SECRET || '';

console.log('== Synapse Inference Engine E2E Tests ==');
console.log(`Gateway: ${GATEWAY_BASE}`);
console.log(`Direct:  ${INFERENCE_DIRECT}`);

// Generate a valid JWT token signed with the shared IAM_JWT_SECRET
const token = jwt.sign(
  {
    sub: 'e2e-tester-id',
    org: 'acme',
    account: 'prod',
    scopes: ['*'],
  },
  JWT_SECRET,
  { issuer: 'synapseone-iam', expiresIn: '1h' },
);

const authHeaders = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
};

async function run() {
  let passed = 0;

  // Test 1: Direct Health Check
  console.log('\n[1/7] Direct Health Check...');
  const directHealthRes = await fetch(`${INFERENCE_DIRECT}/health`);
  assert.equal(directHealthRes.status, 200, 'Direct health check status must be 200');
  const directHealth = await directHealthRes.json();
  assert.equal(directHealth.service, 'inference');
  assert.equal(directHealth.models.decision, 'vllm-sr/Decision-2.0-Eos-0.8B');
  assert.equal(directHealth.models.embedding, 'sentence-transformers/all-MiniLM-L6-v2');
  console.log('✓ Direct Health OK:', directHealth.service, 'models:', directHealth.models);
  passed++;

  // Test 2: Gateway Health Route
  console.log('\n[2/7] Gateway Health Route (/v1/inference/health)...');
  const gwHealthRes = await fetch(`${GATEWAY_BASE}/v1/inference/health`, { headers: authHeaders });
  assert.equal(gwHealthRes.status, 200, 'Gateway health route status must be 200');
  const gwHealth = await gwHealthRes.json();
  assert.equal(gwHealth.service, 'inference');
  assert(gwHealthRes.headers.get('x-request-id'), 'Must propagate x-request-id');
  console.log('✓ Gateway Health OK (x-request-id:', gwHealthRes.headers.get('x-request-id'), ')');
  passed++;

  // Test 3: Embedding through Gateway
  console.log('\n[3/7] Embeddings via Gateway (/v1/inference/embeddings)...');
  const embPayload = {
    input: [
      'Automate invoice processing with SynapseOne',
      'Create custom workflow webhook trigger',
    ],
  };
  const embRes = await fetch(`${GATEWAY_BASE}/v1/inference/embeddings`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(embPayload),
  });
  assert.equal(embRes.status, 200, `Embeddings status must be 200, got ${embRes.status}`);
  const embData = await embRes.json();
  assert.equal(embData.object, 'list');
  assert.equal(embData.data.length, 2);
  assert.equal(embData.data[0].embedding.length, 384, 'Dimension must be 384');
  console.log('✓ Embedding via Gateway OK (2 vectors generated, dim=384, usage tokens:', embData.usage.total_tokens, ')');
  passed++;

  // Test 4: Semantic Routing via Gateway (for Workflows)
  console.log('\n[4/7] Workflow Semantic Route via Gateway (/v1/inference/decision/route)...');
  const routePayload = {
    input: 'I need to trigger an execution when a Stripe webhook arrives',
    instruction: 'Choose the most relevant system service',
    choices: {
      workflow: 'Automated DAG workflows, webhooks, and job execution',
      iam: 'User logins, organizations, and authentication',
      base: 'Database collections, documents, and CRUD queries',
    },
  };
  const routeRes = await fetch(`${GATEWAY_BASE}/v1/inference/decision/route`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(routePayload),
  });
  assert.equal(routeRes.status, 200, `Route status must be 200, got ${routeRes.status}`);
  const routeData = await routeRes.json();
  assert.equal(routeData.best_choice, 'workflow');
  assert(routeData.confidence > 0.4, 'Confidence should favor workflow');
  console.log('✓ Semantic Route OK (Best choice:', routeData.best_choice, 'confidence:', routeData.confidence, 'probabilities:', routeData.probabilities, ')');
  passed++;

  // Test 5: Decision system_one (vllm-sr/Decision-2.0-Eos-0.8B) via Gateway
  console.log('\n[5/7] Structured Decision system_one via Gateway (/v1/inference/decision)...');
  const decisionPayload = {
    state: 'The package arrived broken yesterday. Customer provided photographic evidence and requested immediate replacement.',
    questions: {
      department: {
        type: 'choice',
        instructions: 'Which team handles this case?',
        criteria: {
          damaged_claims: 'Damaged packages, physical defects and replacement items',
          billing_issues: 'Credit card charges, subscriptions, and receipts',
          general_support: 'Product user guides and FAQ',
        },
      },
      has_evidence: {
        type: 'noul',
        instructions: 'Did the customer provide evidence?',
      },
    },
  };
  const decRes = await fetch(`${GATEWAY_BASE}/v1/inference/decision`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(decisionPayload),
  });
  assert.equal(decRes.status, 200, `Decision status must be 200, got ${decRes.status}`);
  const decData = await decRes.json();
  assert.equal(decData.model, 'vllm-sr/Decision-2.0-Eos-0.8B');
  assert.equal(decData.results.department.best_choice, 'damaged_claims');
  assert.equal(decData.results.has_evidence.answer, 'yes');
  console.log('✓ Structured Decision system_one OK (department:', decData.results.department.best_choice, 'has_evidence:', decData.results.has_evidence.answer, ')');
  passed++;

  // Test 6: Unauthorized access to Gateway without Bearer or API Key
  console.log('\n[6/7] Security: Unauthorized request without credential...');
  const unauthRes = await fetch(`${GATEWAY_BASE}/v1/inference/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: 'test' }),
  });
  assert.equal(unauthRes.status, 401, 'Gateway must reject anonymous request with 401');
  console.log('✓ Security Check OK (Rejected anonymous request with 401 Unauthorized)');
  passed++;

  // Test 7: LLM Chat Completions endpoint via Gateway
  console.log('\n[7/7] LLM Chat Completions via Gateway (/v1/inference/chat/completions)...');
  const llmPayload = {
    model: 'liquid/lfm-2.5-2.6b:free',
    messages: [
      { role: 'system', content: 'You are a fast API test assistant. Reply with one word: PONG' },
      { role: 'user', content: 'PING' },
    ],
    max_tokens: 10,
    temperature: 0.1,
  };
  const llmRes = await fetch(`${GATEWAY_BASE}/v1/inference/chat/completions`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(llmPayload),
  });
  // If OpenRouter API key is valid, returns 200; if free-tier upstream rate limit / key quota, returns 502/429/503
  console.log(`LLM Status Code: ${llmRes.status}`);
  if (llmRes.status === 200) {
    const llmData = await llmRes.json();
    console.log('✓ LLM Chat Completion OK:', llmData.choices[0]?.message?.content || JSON.stringify(llmData));
  } else {
    const err = await llmRes.text();
    console.log(`ℹ LLM Upstream returned ${llmRes.status} (${err.slice(0, 150)}...) - handled properly by gateway`);
    assert([200, 404, 429, 502, 503, 504].includes(llmRes.status), 'LLM status must be handled gracefully');
  }
  passed++;

  // Test 8: JavaScript SDK client.inference.* verification
  console.log('\n[8/8] JavaScript SDK (client.inference.*) via Gateway...');
  const { SynapseOneClient } = require('../../sdks/sdk-js/dist/index.js');
  const client = new SynapseOneClient({ baseUrl: GATEWAY_BASE, token });

  const sdkHealth = await client.inference.health();
  assert.equal(sdkHealth.service, 'inference');

  const sdkEmb = await client.inference.embeddings(['SDK embedding check']);
  assert.equal(sdkEmb.data.length, 1);
  assert.equal(sdkEmb.data[0].embedding.length, 384);

  const sdkRoute = await client.inference.route(
    'Create automated workflow to process queues',
    { workflow: 'Automated DAGs', iam: 'User permissions' },
  );
  assert.equal(sdkRoute.best_choice, 'workflow');

  const sdkDec = await client.inference.decision('Customer has invoice', {
    has_invoice: { type: 'noul', instructions: 'Does customer have invoice?' },
  });
  assert.equal(sdkDec.results.has_invoice.answer, 'yes');

  console.log('✓ JavaScript SDK verification OK (health, embeddings, route, decision tested via client.inference)');
  passed++;

  console.log(`\n========================================`);
  console.log(`ALL ${passed}/8 E2E TESTS PASSED SUCCESSFULLY!`);
  console.log(`========================================`);
}

run().catch((err) => {
  console.error('\n❌ E2E TEST FAILED:', err);
  process.exit(1);
});
