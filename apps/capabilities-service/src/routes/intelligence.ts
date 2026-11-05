// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * I-layer intelligence: OCR correction queue (#43), agent governance (#44)
 * and a grounded RAG assistant (#45). All state is Tier-1 Base documents.
 */
import { createHash } from 'crypto';
import { Express } from 'express';
import { isAdmin } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import {
  COLLECTIONS, correlationIdOf, getDocumentOrNull, queryDocuments, recordAudit,
} from '../platform';
import { loadDataset } from '../publication';
import { authenticatedReadContext, writeContext } from './shared';
import {
  createScoped, getScoped, listScoped, newId, nowIso, objectValue, optionalString,
  requiredString, stringArray, updateScoped,
} from './module-helpers';

interface OcrField { name: string; value: string; confidence: number; page: number; bbox?: number[]; status: 'auto' | 'pending' | 'approved' | 'rejected'; note?: string }
interface OcrJobRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  fileId: string; datasetId?: string; status: 'needs_correction' | 'approved' | 'rejected';
  pages: Array<{ page: number; text: string; bbox?: number[]; confidence?: number }>;
  fields: OcrField[]; redacted: boolean;
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
}
interface RagQueryRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  question: string; citations: string[]; tokens: number; costUsd: number; noAnswer: boolean;
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

function embed(text: string): number[] {
  const vector = new Array<number>(48).fill(0);
  for (const token of String(text).toLowerCase().match(/[a-z0-9]{2,}/g) || []) {
    const hash = createHash('sha256').update(token).digest();
    vector[hash.readUInt32BE(0) % vector.length] += (hash[4] & 1) ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  return dot;
}

function extractFields(pages: Array<{ page: number; text: string; bbox?: number[]; confidence?: number }>): OcrField[] {
  const fields: OcrField[] = [];
  for (const page of pages) {
    for (const line of String(page.text || '').split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z][A-Za-z0-9 /_-]{1,60}):\s*(.+)$/);
      if (!match) continue;
      const name = match[1].trim();
      const value = match[2].trim().slice(0, 500);
      const base = page.confidence === undefined ? 0.94 : Math.max(0, Math.min(1, Number(page.confidence)));
      const noisy = /\?{2,}|[^\x20-\x7E\u00C0-\u1EF9]/.test(value) || value.length < 2;
      const confidence = Number(Math.max(0, base - (noisy ? 0.4 : 0)).toFixed(2));
      fields.push({
        name, value, confidence, page: page.page,
        ...(page.bbox ? { bbox: page.bbox } : {}),
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
    const pages = Array.isArray(b.pages) && b.pages.length ? b.pages.slice(0, 100).map((page: any, index) => ({
      page: Number(page?.page) || index + 1,
      text: String(page?.text || '').slice(0, 50_000),
      ...(Array.isArray(page?.bbox) ? { bbox: page.bbox.slice(0, 4).map(Number) } : {}),
      ...(page?.confidence !== undefined ? { confidence: Number(page.confidence) } : {}),
    })) : [{ page: 1, text: String(b.text || '').slice(0, 50_000), ...(Array.isArray(b.bbox) ? { bbox: b.bbox.slice(0, 4).map(Number) } : {}) }];
    const fields = extractFields(pages);
    if (!fields.length) throw apiError(400, 'ocr_empty', 'no key/value fields were extracted');
    const status = fields.some((field) => field.status === 'pending') ? 'needs_correction' : 'approved';
    const job = await createScoped(client, COLLECTIONS.ocrJobs, principal, {
      fileId, ...(b.datasetId ? { datasetId: String(b.datasetId) } : {}), status, pages, fields, redacted: false,
    } as any) as unknown as OcrJobRecord;
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'intelligence.ocr.create',
      correlationId: correlationIdOf(req), details: { jobId: job.id, fields: fields.length, pending: fields.filter((field) => field.status === 'pending').length },
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
    const pages = job.pages.map((page) => ({ ...page, text: redactText(page.text) }));
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
    const chunks: RagChunkRecord[] = [];
    for (let offset = 0, index = 0; offset < text.length; offset += 350, index++) {
      const chunkText = text.slice(offset, offset + 450);
      if (!chunkText.trim()) continue;
      const chunk = await createScoped(client, COLLECTIONS.ragChunks, principal, {
        documentId: docRecord.id, title: docRecord.title, sourceType: docRecord.sourceType,
        sourceId: docRecord.sourceId, acl, text: chunkText, embedding: embed(chunkText), index,
      } as any) as unknown as RagChunkRecord;
      chunks.push(chunk);
    }
    res.status(201).json({ document: docRecord, chunks: chunks.length });
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
    const queryEmbedding = embed(question);
    const stop = new Set(['the', 'and', 'are', 'was', 'were', 'when', 'where', 'what', 'which', 'who', 'why', 'how', 'is', 'it', 'this', 'that', 'for', 'with', 'from', 'into', 'can', 'could', 'should', 'would', 'does', 'did', 'has', 'have', 'had', 'required', 'require']);
    const tokens = (question.match(/[a-z0-9]{2,}/gi) || []).map((token) => token.toLowerCase()).filter((token) => !stop.has(token));
    const chunks = await queryDocuments<RagChunkRecord>(client, COLLECTIONS.ragChunks, {
      where: isAdmin(principal) ? {} : { tenant: principal.tenantKey }, limit: 5000,
    });
    const scored = chunks.items.map((item) => item.data)
      .filter((chunk) => isAdmin(principal) || chunk.tenant === principal.tenantKey)
      .filter((chunk) => allowedByAcl(chunk, principal))
      .map((chunk) => {
        const haystack = `${chunk.title} ${chunk.text}`.toLowerCase();
        const lexical = tokens.reduce((sum, token) => sum + (haystack.split(token).length - 1), 0);
        const vector = Math.max(0, cosine(queryEmbedding, chunk.embedding || []));
        return { chunk, score: lexical * 1.2 + vector * 3 };
      })
      .filter((hit) => tokens.some((token) => `${hit.chunk.title} ${hit.chunk.text}`.toLowerCase().includes(token)))
      .filter((hit) => hit.score > 0)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, topK);
    const citations = scored.map((hit) => `${hit.chunk.sourceType}:${hit.chunk.sourceId}#${hit.chunk.index}`);
    const noAnswer = scored.length === 0;
    const answer = noAnswer ? 'I could not find an answer in the sources you can access.' : scored.map((hit, index) => {
      const sentence = hit.chunk.text.split(/(?<=[.!?])\s+/).find((line) => tokens.some((token) => line.toLowerCase().includes(token))) || hit.chunk.text.slice(0, 240);
      return `${sentence.trim()} [${index + 1}]`;
    }).join(' ');
    const query = await createScoped(client, COLLECTIONS.ragQueries, principal, {
      question, citations, noAnswer, tokens: question.length + answer.length,
      costUsd: Number(((question.length + answer.length) * 0.0000002).toFixed(8)),
    } as any) as unknown as RagQueryRecord;
    res.json({
      answer, citations: citations.map((citation, index) => ({ citation, index: index + 1, title: scored[index].chunk.title, sourceId: scored[index].chunk.sourceId })),
      confidence: noAnswer ? 0 : Number(Math.min(0.99, scored[0].score / 10).toFixed(3)),
      noAnswer, queryId: query.id,
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
