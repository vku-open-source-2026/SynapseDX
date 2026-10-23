/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 * SynapseFlow Pipeline E2E Verification:
 * Verifies SynapseBase Vector Search integration in SynapseFlow workflows.
 * Tests both:
 * 1. Visual pipeline execution with `synapsedx.base` node (`vector-search`) -> transform
 * 2. Execution of persistent saved workflow via gateway API
 */
import assert from 'node:assert/strict';
import { SynapseDXClient } from '../../sdks/sdk-js/dist/index.js';

const baseUrl = process.env.SYNAPSEDX_BASE_URL || 'http://localhost:8080';
const stamp = Date.now().toString(36);

async function main() {
  console.log('--- STARTING SYNAPSEFLOW VECTOR PIPELINE VERIFICATION ---');
  const c = new SynapseDXClient({ baseUrl });
  const login = await c.iam.login(`flow-e2e-${stamp}@acme.local`);
  c.setToken(login.accessToken);

  // 1. Create collection in SynapseBase with vector schema
  const colName = `flow_vec_${stamp}`;
  console.log(`[1] Creating SynapseBase collection: ${colName}...`);
  await c.base.createCollection({
    name: colName,
    description: 'SynapseFlow Vector Search E2E Test',
    mapping: {
      fields: {
        title: { path: 'title', type: 'string', required: true },
        category: { path: 'category', type: 'string' },
        summary: { path: 'summary', type: 'string' },
        embedding: { path: 'embedding', type: 'vector', dimension: 3, metric: 'cosine' },
      },
    },
  });

  // 2. Insert documents with known vector embeddings
  console.log('[2] Inserting knowledge base documents...');
  await c.base.createDocument(colName, {
    id: 'doc-ai-intro',
    object: {
      title: 'Deep Learning and Transformers Guide',
      category: 'ai',
      summary: 'Comprehensive guide covering attention mechanisms and backprop',
      embedding: [1, 0, 0],
    },
  });
  await c.base.createDocument(colName, {
    id: 'doc-db-arch',
    object: {
      title: 'PostgreSQL Internals and Storage Engines',
      category: 'database',
      summary: 'Deep dive into WAL, MVCC, and buffer pools',
      embedding: [0, 1, 0],
    },
  });
  await c.base.createDocument(colName, {
    id: 'doc-ann-search',
    object: {
      title: 'Postgres pgvector Vector Search at Scale',
      category: 'ai',
      summary: 'Practical guide to indexing high-dimensional vectors using HNSW',
      embedding: [0.7071, 0.7071, 0],
    },
  });

  // 3. Construct a SynapseFlow DAG:
  // Node 1: ManualTrigger (trigger)
  // Node 2: VectorSearch (synapsedx.base) -> queries collection for query vector [0.95, 0.05, 0]
  // Node 3: ResultFormatter (n8n-nodes-base.code) -> formats and extracts top match
  console.log('[3] Constructing SynapseFlow DAG...');
  const workflowDefinition = {
    name: `Vector Pipeline E2E ${stamp}`,
    nodes: [
      {
        id: 'node-trigger',
        name: 'ManualTrigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [100, 300],
        parameters: {},
      },
      {
        id: 'node-vector-search',
        name: 'VectorSearch',
        type: 'synapsedx.base',
        typeVersion: 1,
        position: [350, 300],
        parameters: {
          operation: 'vector-search',
          input: {
            collection: colName,
            vector: [1, 0, 0],
            limit: 2,
            includeVector: true,
          },
        },
      },
      {
        id: 'node-formatter',
        name: 'ResultFormatter',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [600, 300],
        parameters: {
          code: `
            const items = $input.items || [];
            return {
              total: $input.total,
              metric: $input.metric,
              topDocId: items.length > 0 ? items[0].id : null,
              topSimilarity: items.length > 0 ? items[0].similarity : null,
              topDocTitle: items.length > 0 ? items[0].data.title : null,
              allIds: items.map(it => it.id),
            };
          `,
        },
      },
    ],
    connections: {
      ManualTrigger: {
        main: [[{ node: 'VectorSearch', type: 'main', index: 0 }]],
      },
      VectorSearch: {
        main: [[{ node: 'ResultFormatter', type: 'main', index: 0 }]],
      },
    },
  };

  // 4. Test-run the pipeline in-engine (interactive editor test-run)
  console.log('[4] Running interactive pipeline test-run...');
  const testRun = await c.workflow.testRun(workflowDefinition, {});
  console.log('test-run status ok:', testRun.ok);
  console.log('test-run output:', JSON.stringify(testRun.output, null, 2));

  assert.equal(testRun.ok, true, `Workflow test-run failed: ${testRun.error}`);
  assert.equal(testRun.output.topDocId, 'doc-ai-intro');
  assert.ok(testRun.output.topSimilarity >= 0.99);
  assert.equal(testRun.output.topDocTitle, 'Deep Learning and Transformers Guide');
  assert.deepEqual(testRun.output.allIds, ['doc-ai-intro', 'doc-ann-search']);

  // 5. Create persistent saved workflow in SynapseFlow
  console.log('[5] Saving workflow to SynapseFlow repository...');
  const createdWf = await c.workflow.createWorkflow(workflowDefinition.name, workflowDefinition);
  console.log(`Saved Workflow ID: ${createdWf.id}`);
  assert.ok(createdWf.id, 'Workflow ID should be present');

  // 6. Execute the saved workflow
  console.log('[6] Executing saved workflow in SynapseFlow runtime...');
  const execRes = await c.workflow.executeWorkflow(createdWf.id, {});
  console.log('Execution result status:', execRes.status);
  console.log('Execution result output:', JSON.stringify(execRes.output, null, 2));

  assert.equal(execRes.status, 'success');
  assert.equal(execRes.output.topDocId, 'doc-ai-intro');
  assert.ok(execRes.output.topSimilarity >= 0.99);
  assert.equal(execRes.output.allIds.length, 2);

  // 7. Test hybrid vector search (vector + where condition) in SynapseFlow pipeline
  console.log('[7] Testing hybrid filtered vector search in SynapseFlow pipeline...');
  const hybridWorkflowDef = {
    name: `Hybrid Vector Pipeline ${stamp}`,
    nodes: [
      {
        id: 'node-trig-h',
        name: 'ManualTrigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [100, 300],
        parameters: {},
      },
      {
        id: 'node-vec-h',
        name: 'VectorSearch',
        type: 'synapsedx.base',
        typeVersion: 1,
        position: [350, 300],
        parameters: {
          operation: 'vector-search',
          input: {
            collection: colName,
            vector: [1, 0, 0],
            where: { category: { eq: 'database' } },
            limit: 5,
          },
        },
      },
    ],
    connections: {
      ManualTrigger: {
        main: [[{ node: 'VectorSearch', type: 'main', index: 0 }]],
      },
    },
  };

  const hybridRun = await c.workflow.testRun(hybridWorkflowDef, {});
  console.log('Hybrid run items count:', hybridRun.output.items.length);
  assert.equal(hybridRun.ok, true);
  assert.equal(hybridRun.output.items.length, 1);
  assert.equal(hybridRun.output.items[0].id, 'doc-db-arch');

  // 8. Clean up
  console.log('[8] Cleaning up workflow and collection...');
  await c.workflow.deleteWorkflow(createdWf.id);
  await c.base.deleteCollection(colName);

  console.log('======================================================');
  console.log('🎉 SYNAPSEFLOW VECTOR PIPELINE VERIFICATION SUCCESSFUL!');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('❌ SYNAPSEFLOW VECTOR PIPELINE VERIFICATION FAILED:', err);
  process.exit(1);
});
