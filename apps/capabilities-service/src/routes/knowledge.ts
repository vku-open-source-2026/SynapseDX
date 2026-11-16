// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Tier-2 knowledge base: documents/chunks in SynapseBase, hybrid vector search
 * (`/v1/search` with pgvector embeddings) plus graph expansion
 * (`/v1/base/.../graph`) and a grounded answer with citations.
 */
import { createHash } from 'node:crypto';
import { Express } from 'express';
import { SynapseOneClient } from '@synapseone/sdk';
import { CallerPrincipal, isAdmin } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { COLLECTIONS, ensureCollections, getDocumentOrNull } from '../platform';
import { authenticatedReadContext, writeContext } from './shared';
import { createScoped, listScoped } from './module-helpers';
import { detectProvinces } from '../crawlers/kttv';

const CHUNK_SIZE = 1800;

const CHUNK_OVERLAP = 200;
const MAX_BODY = 120_000;
const MAX_CHUNKS = 64;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

export interface KnowledgeDocumentRecord {
  id: string;
  tenant: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  body: string;
  source: string;
  url: string;
  publishedAt: string;
  kind: 'text' | 'pdf' | 'html';
  tags: string[];
  hash: string;
}

export interface KnowledgeChunkRecord {
  id: string;
  tenant: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  documentId: string;
  title: string;
  text: string;
  index: number;
}

interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function clean(value: string, max = 500): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * PDF ingestion only accepts catalogued official KTTV documents. The request
 * selects an entry by id (or exact URL); the fetch target itself always comes
 * from this server-side catalog, never from the request body. Operators can
 * add entries with KNOWLEDGE_PDF_CATALOG (JSON array of {id,url,title}).
 */
interface CatalogPdf { id: string; url: string; title?: string }

const DEFAULT_PDF_CATALOG: CatalogPdf[] = [
  {
    id: 'vndms-sos-thanh-hoa',
    url: 'https://s3.vndms.gov.vn/public/sos-message/2346fe380113c1d254ffb76730dac697.pdf',
    title: 'BAN CHỈ HUY PHÒNG THỦ DÂN SỰ TỈNH THANH HOÁ',
  },
  {
    id: 'vndms-sos-cao-bang',
    url: 'https://s3.vndms.gov.vn/public/sos-message/2d4a6c402389381d31e27a7a69c05914.pdf',
    title: 'SỞ NN VÀ MT TỈNH CAO BẰNG — BÁO CÁO THIỆT HẠI',
  },
];

function officialPdfCatalog(): CatalogPdf[] {
  const raw = process.env.KNOWLEDGE_PDF_CATALOG;
  if (!raw) return DEFAULT_PDF_CATALOG;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_PDF_CATALOG;
    const entries = parsed
      .map((item) => ({ id: String(item?.id || ''), url: String(item?.url || ''), title: String(item?.title || '') }))
      .filter((item) => /^[A-Za-z0-9_.:-]{1,80}$/.test(item.id) && /^https:\/\//i.test(item.url));
    return entries.length ? entries : DEFAULT_PDF_CATALOG;
  } catch {
    return DEFAULT_PDF_CATALOG;
  }
}

function resolveCatalogPdf(body: Record<string, unknown>): CatalogPdf {
  const id = String(body.id || '').trim();
  const url = String(body.url || '').trim();
  if (!id && !url) throw apiError(400, 'pdf_not_catalogued', 'id or url of a catalogued KTTV PDF is required');
  const catalog = officialPdfCatalog();
  for (const entry of catalog) {
    if ((id && entry.id === id) || (url && entry.url === url)) return entry;
  }
  throw apiError(400, 'pdf_not_catalogued', 'PDF must be an official catalogued KTTV document');
}

function chunkText(text: string): string[] {
  const body = String(text || '').slice(0, MAX_BODY);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < body.length && chunks.length < MAX_CHUNKS) {
    const end = Math.min(body.length, offset + CHUNK_SIZE);
    chunks.push(body.slice(offset, end));
    if (end >= body.length) break;
    offset = Math.max(end - CHUNK_OVERLAP, offset + 1);
  }
  return chunks;
}

export interface KnowledgeInput {
  title: string;
  body: string;
  source?: string;
  url?: string;
  publishedAt?: string;
  kind?: 'text' | 'pdf' | 'html';
  tags?: string[];
  id?: string;
}

/** Store a document, chunk it for hybrid search and link entities in the graph. */
export async function indexKnowledgeDocument(
  client: SynapseOneClient,
  principal: CallerPrincipal,
  input: KnowledgeInput,
): Promise<{ document: KnowledgeDocumentRecord; chunks: number; graph: { nodes: number; edges: number } }> {
  const title = clean(input.title, 300);
  const body = String(input.body || '').slice(0, MAX_BODY);
  if (!title || body.trim().length < 20) throw apiError(400, 'invalid_document', 'title and a body of at least 20 chars are required');
  const url = clean(input.url || '', 1000);
  const source = clean(input.source || (url ? new URL(url).hostname : 'manual'), 200);
  const hash = sha1(`${title}\n${body}`);
  const id = input.id && /^[A-Za-z0-9_:.@+-]{1,120}$/.test(input.id) ? input.id : `k-${sha1(`${source}|${url}|${title}`).slice(0, 24)}`;

  const existing = await getDocumentOrNull<KnowledgeDocumentRecord>(client, COLLECTIONS.knowledgeDocuments, id);
  if (existing && !isAdmin(principal) && existing.data.tenant !== principal.tenantKey) {
    throw apiError(409, 'record_already_exists', 'a document with this id belongs to another tenant');
  }
  if (existing && existing.data.hash === hash) {
    return { document: existing.data, chunks: 0, graph: { nodes: 0, edges: 0 } };
  }
  const document = existing
    ? { ...existing.data, title, body, source, url, kind: input.kind || existing.data.kind || 'text', hash, updatedAt: new Date().toISOString() }
    : await createScoped<KnowledgeDocumentRecord>(client, COLLECTIONS.knowledgeDocuments, principal, {
        id,
        title,
        body,
        source,
        url,
        publishedAt: input.publishedAt || new Date().toISOString(),
        kind: input.kind || 'text',
        tags: input.tags || [],
        hash,
      } as KnowledgeDocumentRecord);
  if (existing) {
    await client.base.updateDocument(COLLECTIONS.knowledgeDocuments, id, { data: document as unknown as Record<string, unknown> });
  }

  const chunks = chunkText(body);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunkId = `${id}-c${index}`;
    const text = chunks[index];
    if (!text.trim()) continue;
    await client.base.createDocument(COLLECTIONS.knowledgeChunks, {
      id: chunkId,
      data: {
        id: chunkId,
        tenant: principal.tenantKey,
        createdBy: principal.subject,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        documentId: id,
        title,
        text,
        index,
      },
    }).catch(async (error) => {
      if (error instanceof Error && /exist/i.test(error.message)) {
        await client.base.updateDocument(COLLECTIONS.knowledgeChunks, chunkId, { data: { text, title, index } }).catch(() => undefined);
        return;
      }
      throw error;
    });
  }

  // Graph: document -> source and document -> entities (provinces + hazard terms).
  const nodes: Array<{ id: string; labels: string[]; properties: Record<string, unknown> }> = [
    { id: `doc:${id}`, labels: ['Document'], properties: { title, source, url, kind: input.kind || 'text' } },
    { id: `source:${sha1(source).slice(0, 12)}`, labels: ['Source'], properties: { name: source, url } },
  ];
  const edges: Array<{ from: string; to: string; type: string; properties?: Record<string, unknown> }> = [
    { from: `doc:${id}`, to: `source:${sha1(source).slice(0, 12)}`, type: 'FROM' },
  ];
  const provinces = detectProvinces(`${title} ${body}`);
  const entityWords = [
    ...provinces.map((name) => ({ id: `province:${sha1(name).slice(0, 10)}`, name, label: 'Province' })),
    ...['bão', 'lũ', 'lụt', 'sạt lở', 'mưa lớn', 'nắng nóng', 'hạn hán', 'rét']
      .filter((word) => `${title} ${body}`.toLowerCase().includes(word))
      .map((word) => ({ id: `hazard:${sha1(word).slice(0, 10)}`, name: word, label: 'HazardType' })),
  ];
  for (const entity of entityWords.slice(0, 24)) {
    nodes.push({ id: entity.id, labels: [entity.label], properties: { name: entity.name } });
    edges.push({ from: `doc:${id}`, to: entity.id, type: 'MENTIONS' });
  }
  await client.base.graphUpsertNodes(COLLECTIONS.knowledgeDocuments, nodes).catch(() => undefined);
  await client.base.graphUpsertEdges(COLLECTIONS.knowledgeDocuments, edges).catch(() => undefined);
  return { document, chunks: chunks.length, graph: { nodes: nodes.length, edges: edges.length } };
}

export interface KnowledgeAnswer {
  answer: string;
  citations: Array<{ index: number; title: string; documentId: string; url?: string }>;
  entities: string[];
  noAnswer: boolean;
  model?: string;
}

/** Hybrid vector + graph retrieval, then a grounded chat completion. */
export async function answerKnowledgeQuestion(
  client: SynapseOneClient,
  principal: CallerPrincipal,
  question: string,
  topK = 6,
  liveContext = '',
): Promise<KnowledgeAnswer> {
  const q = clean(question, 2000);
  if (!q) throw apiError(400, 'invalid_question', 'question is required');
  const limit = Math.min(Math.max(Math.trunc(topK), 1), 20);
  let hits: any[] = [];
  try {
    const search: any = await client.search.hybrid(q, {
      collections: [COLLECTIONS.knowledgeChunks],
      // Retrieve a wider candidate pool so source diversification below can
      // still surface a fresh NCHMF warning when long PDFs dominate.
      limit: Math.min(Math.max(limit * 5, 20), 50),
    } as any);
    hits = Array.isArray(search?.items) ? search.items : [];
  } catch {
    // Fall back to a Base text query when the search index is unavailable.
    const result = await client.base.queryDocuments(COLLECTIONS.knowledgeChunks, {
      where: { tenant: principal.tenantKey },
      limit,
      orderBy: { field: 'updatedAt', direction: 'desc' },
    } as any).catch(() => ({ items: [] as any[] }));
    hits = result.items.map((item: any) => ({ id: item.data.id, documentId: item.data.id, title: item.data.title, snippet: item.data.text }));
  }

  const chunkDocs: KnowledgeChunkRecord[] = [];
  const perDocument = new Map<string, number>();
  for (const hit of hits) {
    const chunkId = String(hit.documentId || hit.id || '').split(':').pop() || '';
    const doc = await getDocumentOrNull<KnowledgeChunkRecord>(client, COLLECTIONS.knowledgeChunks, chunkId);
    // The search index is collection-wide; enforce the caller's tenant here
    // so a private knowledge document can never leak into another tenant's RAG
    // answer (service/admin credentials still see the shared KTTV corpus).
    if (!doc || (!isAdmin(principal) && doc.data.tenant !== principal.tenantKey)) continue;
    // Cap chunks per source so a long PDF cannot crowd out every other warning.
    const seen = perDocument.get(doc.data.documentId) || 0;
    if (seen >= 2) continue;
    perDocument.set(doc.data.documentId, seen + 1);
    chunkDocs.push(doc.data);
    if (chunkDocs.length >= limit) break;
  }

  const parentIds = [...new Set(chunkDocs.map((chunk) => chunk.documentId))];
  const parentDocs = new Map<string, KnowledgeDocumentRecord>();
  await Promise.all(parentIds.map(async (parentId) => {
    const parent = await getDocumentOrNull<KnowledgeDocumentRecord>(client, COLLECTIONS.knowledgeDocuments, parentId);
    if (parent) parentDocs.set(parentId, parent.data);
  }));
  const entities = new Set<string>();
  for (const parentId of parentIds.slice(0, limit)) {
    const graph: any = await client.base
      .graphNode(COLLECTIONS.knowledgeDocuments, `doc:${parentId}`, { depth: 1, limit: 100 })
      .catch(() => null);
    for (const node of graph?.nodes || []) {
      if (node.id?.startsWith('province:') || node.id?.startsWith('hazard:')) {
        const name = node.properties?.name;
        if (name) entities.add(String(name));
      }
    }
  }

  if (!chunkDocs.length) {
    return { answer: 'Không tìm thấy tài liệu liên quan trong knowledge base.', citations: [], entities: [...entities], noAnswer: true };
  }

  const context = chunkDocs.map((chunk, index) => `[${index + 1}] ${chunk.title}\n${chunk.text.slice(0, 1600)}`).join('\n\n');
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'Bạn là trợ lý khí tượng thủy văn của SynapseCity.',
        'Chỉ trả lời dựa trên CONTEXT được cung cấp. Nếu context không đủ, nói rõ là không đủ dữ liệu.',
        'Trích dẫn nguồn bằng số trong ngoặc vuông, ví dụ [1]. Trả lời ngắn gọn, tiếng Việt.',
        ...(String(liveContext || '').trim()
          ? [`LIVE CONTEXT — cảnh báo đang hoạt động (ưu tiên khi mâu thuẫn với tài liệu cũ):\n${String(liveContext).trim().slice(0, 4000)}`]
          : []),
        `CONTEXT:\n${context}`,
      ].join('\n\n'),
    },
    { role: 'user', content: q },
  ];

  let answer = '';
  let model: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_200));
    const fallbackModel = attempt === 1
      ? String(process.env.KNOWLEDGE_FALLBACK_MODEL || 'inception/mercury-2.5')
      : undefined;
    try {
      const response: any = await client.inference.chat(messages as any, {
        temperature: 0.2,
        max_tokens: fallbackModel ? 2_000 : 700,
        ...(fallbackModel ? { model: fallbackModel } : {}),
      } as any);
      const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
      answer = String(choice?.message?.content ?? response?.message ?? '').trim();
      model = response?.model ? String(response.model) : undefined;
      if (answer) break;
    } catch {
      // Retry once with the configured fallback model before going extractive.
    }
  }
  if (!answer) {
    // No provider answer: return an explicit, grounded fallback instead of a
    // raw chunk that could be mistaken for a generated answer.
    model = undefined;
    if (String(liveContext || '').trim()) {
      answer = `AI đang tạm thời quá tải. Các cảnh báo đang hoạt động:\n${String(liveContext).trim()}`;
    } else {
      answer = `AI đang tạm thời quá tải. Tài liệu liên quan:\n${chunkDocs
        .slice(0, 3)
        .map((chunk, index) => `[${index + 1}] ${chunk.title}: ${chunk.text.slice(0, 220)}`)
        .join('\n')}`;
    }
  }
  if (!answer) {
    answer = chunkDocs
      .slice(0, 3)
      .map((chunk, index) => `[${index + 1}] ${chunk.text.slice(0, 500)}`)
      .join('\n\n');
  }

  const citations = chunkDocs.slice(0, 8).map((chunk, index) => {
    const parent = parentDocs.get(chunk.documentId);
    return {
      index: index + 1,
      title: chunk.title,
      documentId: chunk.documentId,
      ...(parent?.url ? { url: parent.url } : {}),
      ...(parent?.publishedAt ? { publishedAt: parent.publishedAt } : {}),
    };
  });
  return { answer, citations, entities: [...entities].slice(0, 32), noAnswer: false, ...(model ? { model } : {}) };
}

export function registerKnowledgeRoutes(app: Express, config: ServiceConfig): void {
  app.post('/v1/capabilities/knowledge/documents', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    await ensureCollections(client);
    const body = (req.body || {}) as any;
    const result = await indexKnowledgeDocument(client, principal, {
      title: String(body.title || ''),
      body: String(body.body || body.text || ''),
      source: body.source ? String(body.source) : undefined,
      url: body.url ? String(body.url) : undefined,
      publishedAt: body.publishedAt ? String(body.publishedAt) : undefined,
      kind: body.kind === 'pdf' || body.kind === 'html' ? body.kind : 'text',
      tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 20) : [],
      ...(body.id ? { id: String(body.id) } : {}),
    });
    res.status(201).json(result);
  }));

  app.post('/v1/capabilities/knowledge/ingest/pdf', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    await ensureCollections(client);
    const body = (req.body || {}) as any;
    const entry = resolveCatalogPdf(body);
    const url = new URL(entry.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let buffer: Buffer;
    try {
      // entry.url comes from the server-side catalog, never from req.body.
      const response = await fetch(entry.url, { signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw apiError(502, 'pdf_fetch_failed', `upstream returned ${response.status}`);
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_PDF_BYTES) throw apiError(413, 'pdf_too_large', 'PDF exceeds 20 MB');
      buffer = Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
    if (buffer.length > MAX_PDF_BYTES) throw apiError(413, 'pdf_too_large', 'PDF exceeds 20 MB');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdf = require('pdf-parse') as (data: Buffer) => Promise<{ text?: string }>;
    const parsed = await pdf(buffer);
    const text = String(parsed.text || '').replace(/\s+/g, ' ').trim();
    if (text.length < 40) throw apiError(422, 'pdf_no_text', 'the PDF has no extractable text');
    const result = await indexKnowledgeDocument(client, principal, {
      id: `k-pdf-${entry.id}`,
      title: String(body.title || entry.title || url.pathname.split('/').pop() || 'Tài liệu PDF').slice(0, 300),
      body: text,
      source: url.hostname,
      url: url.toString(),
      publishedAt: body.publishedAt ? String(body.publishedAt) : new Date().toISOString(),
      kind: 'pdf',
      tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 20) : ['pdf', 'kttv'],
    });
    res.status(201).json(result);
  }));

  app.get('/v1/capabilities/knowledge/documents', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const limit = Number((req.query as any).limit || 100);
    const { items, total } = await listScoped<KnowledgeDocumentRecord>(client, COLLECTIONS.knowledgeDocuments, principal, {
      limit: Number.isFinite(limit) ? limit : 100,
      orderBy: { field: 'updatedAt', direction: 'desc' },
    });
    res.json({ items: items.map((item) => ({ id: item.id, title: item.title, source: item.source, url: item.url, kind: item.kind, publishedAt: item.publishedAt })), total });
  }));

  app.post('/v1/capabilities/knowledge/query', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const body = (req.body || {}) as any;
    const question = String(body.question || body.q || '').trim();
    const liveContext = String(body.context || '').trim().slice(0, 4000);
    const result = await answerKnowledgeQuestion(client, principal, question, Number(body.topK || 6), liveContext);
    res.json(result);
  }));

  app.get('/v1/capabilities/knowledge/status', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const docs = await listScoped<KnowledgeDocumentRecord>(client, COLLECTIONS.knowledgeDocuments, principal, { limit: 1000 }).catch(() => ({ items: [], total: 0 }));
    const chunks = await listScoped<KnowledgeChunkRecord>(client, COLLECTIONS.knowledgeChunks, principal, { limit: 1000 }).catch(() => ({ items: [], total: 0 }));
    const graph: any = await client.base.graphStats(COLLECTIONS.knowledgeDocuments).catch(() => ({ nodes: 0, edges: 0 }));
    res.json({
      documents: docs.total,
      chunks: chunks.total,
      graphNodes: graph.nodes || 0,
      graphEdges: graph.edges || 0,
      backend: 'synapsebase-vector+graph',
      admin: isAdmin(principal),
    });
  }));
}
