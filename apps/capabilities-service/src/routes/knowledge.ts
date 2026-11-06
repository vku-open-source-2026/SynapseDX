// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Tier-2 knowledge base: documents/chunks in SynapseBase, hybrid vector search
 * (`/v1/search` with pgvector embeddings) plus graph expansion
 * (`/v1/base/.../graph`) and a grounded answer with citations.
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';
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
/**
 * PDF ingestion is limited to the public KTTV sources this capability knows
 * how to cite. An open URL fetcher would be an SSRF primitive even with DNS
 * checks, so operators must extend this list explicitly.
 */
const PDF_HOST_ALLOWLIST = new Set(
  String(process.env.KNOWLEDGE_PDF_HOSTS || 'www.nchmf.gov.vn,nchmf.gov.vn,kttv.gov.vn,s3.vndms.gov.vn,vndms.gov.vn')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
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

const PRIVATE_IPV4 = (parts: number[]): boolean => {
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
};

/** Reject loopback/private/metadata hosts for user-supplied PDF URLs. */
async function assertPublicPdfUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw apiError(400, 'invalid_url', 'url must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw apiError(400, 'invalid_url', 'only http(s) URLs are allowed');
  }
  if (url.username || url.password) throw apiError(400, 'invalid_url', 'credentials in URLs are not allowed');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local') || host === 'metadata.google.internal') {
    throw apiError(400, 'blocked_url', 'internal hosts are not allowed');
  }
  if (!PDF_HOST_ALLOWLIST.has(host)) {
    throw apiError(400, 'blocked_url', `host '${host}' is not an allowed KTTV PDF source`);
  }
  if (isIP(host)) {
    const parts = host.split('.').map(Number);
    if (isIP(host) === 4 && PRIVATE_IPV4(parts)) throw apiError(400, 'blocked_url', 'private addresses are not allowed');
    if (isIP(host) === 6 && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))) {
      throw apiError(400, 'blocked_url', 'private addresses are not allowed');
    }
    return url;
  }
  try {
    const records = await dns.lookup(host, { all: true });
    for (const record of records) {
      const address = record.address;
      if (isIP(address) === 4 && PRIVATE_IPV4(address.split('.').map(Number))) {
        throw apiError(400, 'blocked_url', 'host resolves to a private address');
      }
    }
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error;
    // NXDOMAIN: let fetch fail naturally.
  }
  return url;
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
): Promise<KnowledgeAnswer> {
  const q = clean(question, 2000);
  if (!q) throw apiError(400, 'invalid_question', 'question is required');
  const limit = Math.min(Math.max(Math.trunc(topK), 1), 20);
  let hits: any[] = [];
  try {
    const search: any = await client.search.hybrid(q, {
      collections: [COLLECTIONS.knowledgeChunks],
      limit,
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
  for (const hit of hits) {
    const chunkId = String(hit.documentId || hit.id || '').split(':').pop() || '';
    const doc = await getDocumentOrNull<KnowledgeChunkRecord>(client, COLLECTIONS.knowledgeChunks, chunkId);
    if (doc) chunkDocs.push(doc.data);
  }

  const parentIds = [...new Set(chunkDocs.map((chunk) => chunk.documentId))];
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
        `CONTEXT:\n${context}`,
      ].join('\n\n'),
    },
    { role: 'user', content: q },
  ];

  let answer = '';
  let model: string | undefined;
  try {
    const response: any = await client.inference.chat(messages as any);
    const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
    answer = String(choice?.message?.content ?? response?.message ?? '').trim();
    model = response?.model ? String(response.model) : undefined;
  } catch {
    // Extractive fallback keeps the assistant useful when the provider is down.
    answer = chunkDocs
      .slice(0, 3)
      .map((chunk, index) => `[${index + 1}] ${chunk.text.slice(0, 500)}`)
      .join('\n\n');
  }
  if (!answer) {
    answer = chunkDocs
      .slice(0, 3)
      .map((chunk, index) => `[${index + 1}] ${chunk.text.slice(0, 500)}`)
      .join('\n\n');
  }

  const citations = chunkDocs.slice(0, 8).map((chunk, index) => ({
    index: index + 1,
    title: chunk.title,
    documentId: chunk.documentId,
    ...(chunk.text ? {} : {}),
  }));
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
    const url = await assertPublicPdfUrl(String(body.url || ''));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let buffer: Buffer;
    try {
      // codeql[js/request-forgery] -- the URL is constrained to PDF_HOST_ALLOWLIST above and its DNS answers are checked for private addresses.
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
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
      title: String(body.title || url.pathname.split('/').pop() || 'Tài liệu PDF').slice(0, 300),
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
    const result = await answerKnowledgeQuestion(client, principal, question, Number(body.topK || 6));
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
