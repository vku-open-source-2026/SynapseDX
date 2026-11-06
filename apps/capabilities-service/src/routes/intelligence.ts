// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * I-layer intelligence: OCR correction queue (#43), agent governance (#44)
 * and a grounded RAG assistant (#45). All state is Tier-1 Base documents.
 */
import { Express } from 'express';
import { isAdmin } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { OcrPage, recognizeImage } from '../ocr';
import {
  COLLECTIONS, correlationIdOf, getDocumentOrNull, queryDocuments, recordAudit,
} from '../platform';
import { loadDataset } from '../publication';
import {
  LEGACY_EMBEDDING_MODEL, SEMANTIC_MIN_SCORE, cosine, embedTexts, embeddingProvider, generateAnswer,
  legacyEmbed, lexicalScore, tokenize,
} from '../rag';
import { loadFile, readFileBytes } from './files';
import { authenticatedReadContext, writeContext } from './shared';
import {
  createScoped, getScoped, listScoped, newId, nowIso, objectValue, optionalString,
  requiredString, stringArray, updateScoped,
} from './module-helpers';

interface OcrField { name: string; value: string; confidence: number; page: number; bbox?: number[]; status: 'auto' | 'pending' | 'approved' | 'rejected'; note?: string }
interface OcrJobRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  fileId: string; datasetId?: string; status: 'needs_correction' | 'approved' | 'rejected';
  pages: OcrPage[];
  fields: OcrField[]; redacted: boolean;
  source?: 'client_text' | 'engine';
  engine?: { name: string; languages: string; durationMs: number };
}
interface AgentRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  name: string; owner: string; model: string; promptVersion: string; tools: string[]; riskTier: 'low' | 'medium' | 'high';
}
interface AgentRunRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  agentId: string; status: 'paused' | 'completed' | 'denied' | 'cancelled'; input: Record<string, any>;
  toolCalls: Array<{ tool: string; args?: Record<string, any> }>; output?: Record<string, any>;
  approvalId?: string; correlationId: string; costUsd: number; latencyMs: number; trace: Record<string, any>;
}
interface RagDocumentRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  title: string; sourceType: string; sourceId: string; acl: string[]; text: string;
}
interface RagChunkRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  documentId: string; title: string; sourceType: string; sourceId: string; acl: string[]; text: string; embedding: number[]; index: number;
  /** Absent on chunks written before Tier-1 embeddings (= legacy hash). */
  embeddingModel?: string;
}
interface RagQueryRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  question: string; citations: string[]; tokens: number; costUsd: number; noAnswer: boolean;
  generator?: 'llm' | 'extractive'; retrieval?: string;
}

const SECRET_KEY = /(pass(word)?|secret|token|authorization|api[-_]?key|credential)/i;
const PII_PATTERNS = [
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: 'phone', re: /(?:\+?\d[\d .-]{7,}\d)/g },
  { name: 'id', re: /\b\d{9,12}\b/g },
];

function redactText(text: string): string {
  let output = String(text || '');
  for (const pattern of PII_PATTERNS) output = output.replace(pattern.re, `[REDACTED:${pattern.name}]`);
  return output;
}

function redactObject(value: any, depth = 0): any {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactObject(item, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactObject(item, depth + 1);
    }
    return output;
  }
  if (typeof value === 'string') return redactText(value).slice(0, 20_000);
  return value;
}

/** "Label: value" lines become fields; engine lines carry their own bbox/confidence. */
function extractFields(pages: OcrPage[]): OcrField[] {
  const fields: OcrField[] = [];
  for (const page of pages) {
    const lines = page.lines?.length
      ? page.lines
      : String(page.text || '').split(/\r?\n/).map((text) => ({ text, confidence: page.confidence, bbox: page.bbox }));
    for (const line of lines) {
      const match = String(line.text || '').match(/^([\p{L}][\p{L}\p{N} ./_-]{1,60}?)\s*:\s*(.+)$/u);
      if (!match) continue;
      const name = match[1].trim();
      const value = match[2].trim().slice(0, 500);
      const base = line.confidence === undefined ? 0.94 : Math.max(0, Math.min(1, Number(line.confidence)));
      const noisy = /\?{2,}|[^\x20-\x7E\u00C0-\u1EF9]/.test(value) || value.length < 2;
      const confidence = Number(Math.max(0, base - (noisy ? 0.4 : 0)).toFixed(2));
      fields.push({
        name, value, confidence, page: page.page,
        ...(line.bbox ? { bbox: line.bbox } : {}),
        status: confidence >= 0.7 ? 'auto' : 'pending',
      });
    }
  }
  return fields.slice(0, 200);
}

function allowedByAcl(record: { acl?: string[] }, principal: { subject: string; tenantKey: string; org?: string; account?: string }): boolean {
  if (!record.acl?.length || record.acl.includes('*')) return true;
  return record.acl.includes(principal.subject)
    || (!!principal.org && record.acl.includes(`org:${principal.org}`))
    || (!!principal.account && record.acl.includes(`account:${principal.account}`));
}

export function registerIntelligenceRoutes(app: Express, config: ServiceConfig): void {
  // ---------------- OCR ----------------
  app.post('/v1/capabilities/ocr/jobs', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const fileId = requiredString(b.fileId, 'fileId', 1, 128);
    if (b.datasetId) {
      const dataset = await loadDataset(client, String(b.datasetId));
      if (!dataset || (!isAdmin(principal) && dataset.data.tenant !== principal.tenantKey)) throw apiError(404, 'dataset_not_found', 'dataset not found');
    }
    const clientText = (Array.isArray(b.pages) && b.pages.length > 0) || (typeof b.text === 'string' && b.text.trim() !== '');
    let pages: OcrPage[];
    let engine: OcrJobRecord['engine'];
    if (clientText) {
      // Pre-extracted text (for example from a scanner or a client-side engine).
      pages = Array.isArray(b.pages) && b.pages.length ? b.pages.slice(0, 100).map((page: any, index) => ({
        page: Number(page?.page) || index + 1,
        text: String(page?.text || '').slice(0, 50_000),
        ...(Array.isArray(page?.bbox) ? { bbox: page.bbox.slice(0, 4).map(Number) } : {}),
        ...(page?.confidence !== undefined ? { confidence: Number(page.confidence) } : {}),
      })) : [{ page: 1, text: String(b.text || '').slice(0, 50_000), ...(Array.isArray(b.bbox) ? { bbox: b.bbox.slice(0, 4).map(Number) } : {}) }];
    } else {
      // Read the stored Tier-2 file (tenant-checked) and run the OCR engine on it.
      const file = await loadFile(client, fileId, { principal });
      const bytes = await readFileBytes(client, config, file);
      const result = await recognizeImage(config, bytes, file.data.contentType);
      pages = result.pages;
      engine = result.engine;
      if (!pages.some((page) => page.text.trim())) throw apiError(422, 'ocr_no_text', 'the OCR engine found no text in this image');
    }
    const fields = extractFields(pages);
    if (!fields.length) throw apiError(400, 'ocr_empty', 'no key/value fields were extracted', engine ? { text: pages.map((page) => page.text).join('\n').slice(0, 2000) } : undefined);
    const status = fields.some((field) => field.status === 'pending') ? 'needs_correction' : 'approved';
    const job = await createScoped(client, COLLECTIONS.ocrJobs, principal, {
      fileId, ...(b.datasetId ? { datasetId: String(b.datasetId) } : {}), status, pages, fields, redacted: false,
      source: engine ? 'engine' : 'client_text', ...(engine ? { engine } : {}),
    } as any) as unknown as OcrJobRecord;
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'intelligence.ocr.create',
      correlationId: correlationIdOf(req),
      details: { jobId: job.id, fields: fields.length, pending: fields.filter((field) => field.status === 'pending').length, source: engine ? 'engine' : 'client_text', ...(engine ? { durationMs: engine.durationMs } : {}) },
    });
    res.status(201).json({ job });
  }));

  app.get('/v1/capabilities/ocr/jobs', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const where: Record<string, unknown> = {};
    if (req.query.status) where.status = String(req.query.status);
    const { items } = await listScoped<OcrJobRecord>(client, COLLECTIONS.ocrJobs, principal, { where, limit: 500 });
    res.json({ items, total: items.length });
  }));

  app.get('/v1/capabilities/ocr/jobs/:id', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { record } = await getScoped<OcrJobRecord>(client, COLLECTIONS.ocrJobs, String(req.params.id), principal, 'ocr_job_not_found');
    res.json({ job: record });
  }));

  app.post('/v1/capabilities/ocr/jobs/:id/redact', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: job } = await getScoped<OcrJobRecord>(client, COLLECTIONS.ocrJobs, String(req.params.id), principal, 'ocr_job_not_found');
    const fields = job.fields.map((field) => ({ ...field, value: redactText(field.value) }));
    const pages = job.pages.map((page) => ({
      ...page, text: redactText(page.text),
      ...(page.lines ? { lines: page.lines.map((line) => ({ ...line, text: redactText(line.text) })) } : {}),
    }));
    const updated = await updateScoped(client, COLLECTIONS.ocrJobs, job.id, principal, { fields, pages, redacted: true } as any);
    res.json({ job: updated });
  }));

  app.post('/v1/capabilities/ocr/jobs/:id/fields/:field/correct', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: job } = await getScoped<OcrJobRecord>(client, COLLECTIONS.ocrJobs, String(req.params.id), principal, 'ocr_job_not_found');
    const index = job.fields.findIndex((field) => field.name === req.params.field);
    if (index < 0) throw apiError(404, 'field_not_found', 'extracted field not found');
    const b = (req.body || {}) as Record<string, unknown>;
    const decision = String(b.decision || 'approve').toLowerCase();
    if (!['approve', 'reject'].includes(decision)) throw apiError(400, 'invalid_request', 'decision must be approve or reject');
    const value = decision === 'approve' ? requiredString(b.value ?? job.fields[index].value, 'value', 1, 500) : job.fields[index].value;
    const fields = job.fields.map((field, i) => i === index ? {
      ...field, value, status: decision === 'approve' ? 'approved' as const : 'rejected' as const,
      ...(b.note ? { note: String(b.note).slice(0, 500) } : {}),
    } : field);
    const pending = fields.some((field) => field.status === 'pending');
    const status = pending ? 'needs_correction' : fields.some((field) => field.status === 'approved') ? 'approved' : 'rejected';
    const updated = await updateScoped(client, COLLECTIONS.ocrJobs, job.id, principal, { fields, status } as any);

    let record: any = null;
    if (status === 'approved' && job.datasetId) {
      const dataset = await loadDataset(client, job.datasetId);
      if (!dataset || (!isAdmin(principal) && dataset.data.tenant !== principal.tenantKey)) throw apiError(404, 'dataset_not_found', 'dataset not found');
      const data = Object.fromEntries(fields.filter((field) => field.status === 'approved' || field.status === 'auto').map((field) => [field.name, field.value]));
      record = {
        id: newId(), datasetId: job.datasetId, data,
        provenance: { fileId: job.fileId, pages: fields.filter((f) => f.status === 'approved').map((f) => ({ field: f.name, page: f.page, bbox: f.bbox })) },
        createdAt: nowIso(), updatedAt: nowIso(), published: false,
      };
      await client.base.createDocument(COLLECTIONS.records, { id: record.id, data: record });
    }
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'intelligence.ocr.correct',
      correlationId: correlationIdOf(req), details: { jobId: job.id, field: req.params.field, decision, status },
    });
    res.json({ job: updated, record });
  }));

  // ---------------- agent governance ----------------
  app.post('/v1/capabilities/agents', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const tools = stringArray(b.tools, 'tools', 100);
    if (!tools.length) throw apiError(400, 'invalid_request', 'tools[] is required (deny by default)');
    const agent = await createScoped(client, COLLECTIONS.agents, principal, {
      name: requiredString(b.name, 'name', 1, 200), owner: optionalString(b.owner, 'owner', 128) || principal.subject,
      model: requiredString(b.model, 'model', 1, 128), promptVersion: requiredString(b.promptVersion, 'promptVersion', 1, 64),
      tools, riskTier: ['low', 'medium', 'high'].includes(String(b.riskTier)) ? String(b.riskTier) : 'low',
    } as any) as unknown as AgentRecord;
    res.status(201).json({ agent });
  }));

  app.get('/v1/capabilities/agents', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { items } = await listScoped<AgentRecord>(client, COLLECTIONS.agents, principal, { limit: 500 });
    res.json({ items, total: items.length });
  }));

  app.post('/v1/capabilities/agents/:id/kill-switch', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: agent } = await getScoped<AgentRecord>(client, COLLECTIONS.agents, String(req.params.id), principal, 'agent_not_found');
    const enabled = (req.body || {}).enabled !== false;
    const id = `${agent.tenant}:kill-switch`;
    const existing = await getDocumentOrNull<any>(client, COLLECTIONS.moduleSettings, id);
    const data = { id, tenant: agent.tenant, key: 'agent.killSwitch', enabled, updatedBy: principal.subject, updatedAt: nowIso(), createdBy: existing?.data.createdBy || principal.subject, createdAt: existing?.data.createdAt || nowIso() };
    if (existing) await client.base.updateDocument(COLLECTIONS.moduleSettings, id, { data });
    else await client.base.createDocument(COLLECTIONS.moduleSettings, { id, data });
    if (enabled) {
      const paused = await queryDocuments<AgentRunRecord>(client, COLLECTIONS.agentRuns, { where: { tenant: agent.tenant, status: 'paused' }, limit: 1000 });
      for (const run of paused.items) {
        await updateScoped(client, COLLECTIONS.agentRuns, run.id, principal, { status: 'cancelled', updatedAt: nowIso() } as any);
      }
    }
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'intelligence.agent.kill_switch',
      correlationId: correlationIdOf(req), details: { agentId: agent.id, enabled },
    });
    res.json({ ok: true, enabled });
  }));

  async function executeAgentRun(client: any, principal: any, agent: AgentRecord, run: AgentRunRecord): Promise<AgentRunRecord> {
    const started = Date.now();
    const toolCalls = run.toolCalls.slice(0, 50);
    const output = { summary: `agent ${agent.name} processed ${Object.keys(run.input).length} input fields`, tools: toolCalls.map((call) => call.tool) };
    const trace = {
      correlationId: run.correlationId,
      input: redactObject(run.input),
      toolCalls: toolCalls.map((call) => ({ tool: call.tool, args: redactObject(call.args || {}) })),
      output: redactObject(output),
      approvalId: run.approvalId,
    };
    return updateScoped(client, COLLECTIONS.agentRuns, run.id, principal, {
      status: 'completed', output, trace, latencyMs: Date.now() - started,
      costUsd: Number((0.0001 * (JSON.stringify(trace).length / 1000 + toolCalls.length)).toFixed(6)),
    } as any);
  }

  app.post('/v1/capabilities/agents/:id/runs', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: agent } = await getScoped<AgentRecord>(client, COLLECTIONS.agents, String(req.params.id), principal, 'agent_not_found');
    const kill = await getDocumentOrNull<any>(client, COLLECTIONS.moduleSettings, `${agent.tenant}:kill-switch`);
    if (kill?.data?.enabled) throw apiError(409, 'agent_kill_switch', 'agent execution is disabled by the tenant kill switch');
    const b = (req.body || {}) as Record<string, unknown>;
    const input = objectValue(b.input, 'input', 100_000);
    const toolCalls = Array.isArray(b.toolCalls) ? b.toolCalls.slice(0, 50).map((call: any) => ({ tool: String(call?.tool || ''), args: objectValue(call?.args, 'toolCall.args', 20_000) })) : [];
    for (const call of toolCalls) {
      if (!agent.tools.includes(call.tool)) {
        throw apiError(403, 'tool_not_allowed', `tool '${call.tool}' is not in the agent allowlist`, { allowed: agent.tools });
      }
      if (!call.tool) throw apiError(400, 'invalid_request', 'toolCalls[].tool is required');
    }
    const highRisk = agent.riskTier === 'high' || input.highRisk === true || toolCalls.some((call) => /delete|drop|transfer|dispatch|publish/i.test(call.tool));
    const now = nowIso();
    let approvalId: string | undefined;
    if (highRisk && !b.approvalId) {
      approvalId = newId();
      const approval = {
        id: approvalId, tenant: agent.tenant, title: `Agent action: ${agent.name}`, module: 'intelligence.agent',
        action: 'agent.run', entityType: 'agent', entityId: agent.id, requester: principal.subject,
        approverRoles: ['moderator'], requiredApprovals: 1, status: 'pending', decisions: [], createdAt: now, updatedAt: now,
      };
      await client.base.createDocument(COLLECTIONS.approvals, { id: approvalId, data: approval });
    }
    const run = await createScoped(client, COLLECTIONS.agentRuns, principal, {
      agentId: agent.id, status: approvalId ? 'paused' : 'completed', input, toolCalls,
      ...(approvalId ? { approvalId } : {}), correlationId: correlationIdOf(req), costUsd: 0, latencyMs: 0,
      trace: { correlationId: correlationIdOf(req), input: redactObject(input), toolCalls: toolCalls.map((c) => ({ tool: c.tool, args: redactObject(c.args) })) },
    } as any) as unknown as AgentRunRecord;
    const finished = approvalId ? run : await executeAgentRun(client, principal, agent, run);
    res.status(approvalId ? 202 : 201).json({ run: finished, ...(approvalId ? { approvalRequired: true, approvalId } : {}) });
  }));

  app.post('/v1/capabilities/agent-runs/:id/resume', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: run } = await getScoped<AgentRunRecord>(client, COLLECTIONS.agentRuns, String(req.params.id), principal, 'agent_run_not_found');
    if (run.status !== 'paused' || !run.approvalId) throw apiError(409, 'run_not_paused', 'agent run is not awaiting approval');
    const approvalDoc = await getDocumentOrNull<any>(client, COLLECTIONS.approvals, run.approvalId);
    if (!approvalDoc || approvalDoc.data.status !== 'approved') throw apiError(409, 'approval_required', 'the approval is not approved');
    const { record: agent } = await getScoped<AgentRecord>(client, COLLECTIONS.agents, run.agentId, principal, 'agent_not_found');
    const finished = await executeAgentRun(client, principal, agent, run);
    res.json({ run: finished });
  }));

  app.get('/v1/capabilities/agent-runs', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const where: Record<string, unknown> = {};
    if (req.query.agentId) where.agentId = String(req.query.agentId);
    if (req.query.status) where.status = String(req.query.status);
    const { items } = await listScoped<AgentRunRecord>(client, COLLECTIONS.agentRuns, principal, { where, limit: 500 });
    res.json({ items, total: items.length });
  }));

  // ---------------- RAG ----------------
  app.post('/v1/capabilities/rag/documents', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const text = requiredString(b.text, 'text', 1, 500_000);
    const acl = stringArray(b.acl, 'acl', 100);
    const docRecord = await createScoped(client, COLLECTIONS.ragDocuments, principal, {
      title: requiredString(b.title, 'title', 1, 240), sourceType: optionalString(b.sourceType, 'sourceType', 64) || 'manual',
      sourceId: optionalString(b.sourceId, 'sourceId', 256) || newId(), acl, text,
    } as any) as unknown as RagDocumentRecord;
    const pieces: Array<{ index: number; text: string }> = [];
    for (let offset = 0, index = 0; offset < text.length; offset += 350, index++) {
      const chunkText = text.slice(offset, offset + 450);
      if (chunkText.trim()) pieces.push({ index, text: chunkText });
    }
    const provider = await embeddingProvider(config);
    const embedded = await embedTexts(config, provider, pieces.map((piece) => `${docRecord.title}\n${piece.text}`));
    for (let i = 0; i < pieces.length; i++) {
      await createScoped(client, COLLECTIONS.ragChunks, principal, {
        documentId: docRecord.id, title: docRecord.title, sourceType: docRecord.sourceType,
        sourceId: docRecord.sourceId, acl, text: pieces[i].text, index: pieces[i].index,
        embedding: embedded.vectors[i], embeddingModel: embedded.model,
      } as any);
    }
    res.status(201).json({ document: docRecord, chunks: pieces.length, embeddingModel: embedded.model });
  }));

  app.get('/v1/capabilities/rag/documents', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { items } = await listScoped<RagDocumentRecord>(client, COLLECTIONS.ragDocuments, principal, { limit: 500 });
    res.json({ items: items.map(({ text, ...rest }) => ({ ...rest, chars: text.length })), total: items.length });
  }));

  app.post('/v1/capabilities/rag/query', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const question = requiredString(b.question, 'question', 2, 4000);
    if (/ignore (all )?(previous|prior) instructions|reveal (the )?system prompt|jailbreak|developer message/i.test(question)) {
      throw apiError(400, 'prompt_injection_blocked', 'the question contains a prompt-injection pattern');
    }
    const topK = Math.min(Math.max(Number(b.topK) || 4, 1), 10);
    const tokens = tokenize(question);
    const provider = await embeddingProvider(config);
    // One query vector per embedding space: chunks are only compared with
    // vectors from the model that produced them.
    const legacyQuery = legacyEmbed(question);
    const neural = provider.kind === 'tier1' ? await embedTexts(config, provider, [question]) : null;
    const neuralQuery = neural && neural.model === provider.model ? neural.vectors[0] : null;
    const chunks = await queryDocuments<RagChunkRecord>(client, COLLECTIONS.ragChunks, {
      where: isAdmin(principal) ? {} : { tenant: principal.tenantKey }, limit: 5000,
    });
    const scored = chunks.items.map((item) => item.data)
      .filter((chunk) => isAdmin(principal) || chunk.tenant === principal.tenantKey)
      .filter((chunk) => allowedByAcl(chunk, principal))
      .map((chunk) => {
        const lexical = lexicalScore(tokens, `${chunk.title} ${chunk.text}`);
        const model = chunk.embeddingModel || LEGACY_EMBEDDING_MODEL;
        const semantic = neuralQuery && model === provider.model;
        const vector = Math.max(0, cosine(semantic ? neuralQuery : legacyQuery, chunk.embedding || []));
        return { chunk, lexical, vector, semantic, score: lexical * 1.2 + vector * 3 };
      })
      // Keyword overlap always counts; a pure-meaning match needs a real model.
      .filter((hit) => hit.lexical > 0 || (hit.semantic && hit.vector >= SEMANTIC_MIN_SCORE))
      .sort((a, b2) => b2.score - a.score)
      .slice(0, topK);
    const citations = scored.map((hit) => `${hit.chunk.sourceType}:${hit.chunk.sourceId}#${hit.chunk.index}`);
    const noAnswer = scored.length === 0;
    const extractive = noAnswer ? 'I could not find an answer in the sources you can access.' : scored.map((hit, index) => {
      const sentence = hit.chunk.text.split(/(?<=[.!?])\s+/).find((line) => lexicalScore(tokens, line) > 0) || hit.chunk.text.slice(0, 240);
      return `${sentence.trim()} [${index + 1}]`;
    }).join(' ');
    const generated = !noAnswer && b.generate !== false
      ? await generateAnswer(config, question, scored.map((hit) => ({ title: hit.chunk.title, text: hit.chunk.text })))
      : null;
    const answer = generated?.answer || extractive;
    const generator: 'llm' | 'extractive' = generated ? 'llm' : 'extractive';
    const retrieval = neuralQuery ? provider.model : LEGACY_EMBEDDING_MODEL;
    const usedTokens = generated?.tokens || question.length + answer.length;
    const query = await createScoped(client, COLLECTIONS.ragQueries, principal, {
      question, citations, noAnswer, tokens: usedTokens, generator, retrieval,
      costUsd: Number(((question.length + answer.length) * 0.0000002).toFixed(8)),
    } as any) as unknown as RagQueryRecord;
    res.json({
      answer, citations: citations.map((citation, index) => ({ citation, index: index + 1, title: scored[index].chunk.title, sourceId: scored[index].chunk.sourceId })),
      confidence: noAnswer ? 0 : Number(Math.min(0.99, scored[0].score / 10).toFixed(3)),
      noAnswer, queryId: query.id,
      generator, retrieval, ...(generated ? { model: generated.model } : {}),
    });
  }));

  app.get('/v1/capabilities/rag/usage', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { items } = await listScoped<RagQueryRecord>(client, COLLECTIONS.ragQueries, principal, { limit: 5000 });
    const costUsd = items.reduce((sum, item) => sum + Number(item.costUsd || 0), 0);
    const tokens = items.reduce((sum, item) => sum + Number(item.tokens || 0), 0);
    res.json({ queries: items.length, tokens, costUsd: Number(costUsd.toFixed(6)), noAnswer: items.filter((item) => item.noAnswer).length });
  }));
}
