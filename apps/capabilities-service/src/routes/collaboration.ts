// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * H-layer collaboration: comments/mentions, a single inbox with per-user
 * preferences (#32), plus workspaces, wiki pages, versions and attachments
 * (#35). All persistence goes through Tier-1 Base via the SDK.
 */
import { Express } from 'express';
import { SynapseOneError } from '@synapseone/sdk';
import { isAdmin } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import {
  COLLECTIONS, correlationIdOf, getDocumentOrNull, queryDocuments, recordAudit,
} from '../platform';
import { authenticatedReadContext, readContext, writeContext } from './shared';
import {
  assertOwnerOrAdmin, createScoped, getScoped, listScoped, newId, nowIso,
  objectValue, optionalString, requiredString, stringArray, updateScoped,
} from './module-helpers';

interface CommentRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  module: string; entityType: string; entityId: string; body: string; mentions: string[]; dedupeKey?: string;
}

interface InboxRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  recipient: string; module: string; kind: string; title: string; body: string;
  entityType?: string; entityId?: string; status: 'unread' | 'read' | 'archived';
  dedupeKey: string; delivered: boolean;
}

interface PreferenceRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  subject: string; channels: string[]; muted: boolean;
  quietHours?: { start: number; end: number; timezone?: string };
  digest: 'instant' | 'daily' | 'weekly';
}

interface WorkspaceRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  name: string; description?: string; para: 'projects' | 'areas' | 'resources' | 'archive';
  visibility: 'private' | 'team'; owner: string;
  members: Array<{ subject: string; role: 'owner' | 'editor' | 'viewer' }>;
}

interface PageRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  workspaceId: string; title: string; markdown: string; folder: string;
  tags: string[]; versions: Array<{ version: number; title: string; markdown: string; at: string; by: string }>;
  attachments: Array<{ fileId: string; name: string; checksum?: string; addedAt: string }>;
}

function inQuietHours(prefs: PreferenceRecord, at = new Date()): boolean {
  if (!prefs.quietHours) return false;
  const hour = at.getUTCHours();
  const { start, end } = prefs.quietHours;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

function canAccessWorkspace(ws: WorkspaceRecord, subject: string, admin: boolean): boolean {
  if (admin) return true;
  if (ws.owner === subject) return true;
  return ws.members.some((m) => m.subject === subject);
}

function canEditWorkspace(ws: WorkspaceRecord, subject: string, admin: boolean): boolean {
  if (admin) return true;
  if (ws.owner === subject) return true;
  return ws.members.some((m) => m.subject === subject && (m.role === 'owner' || m.role === 'editor'));
}

async function loadWorkspace(client: any, id: string, tenantKey: string): Promise<WorkspaceRecord> {
  const document = await getDocumentOrNull<WorkspaceRecord>(client, COLLECTIONS.workspaces, id);
  if (!document) console.error('[debug] ws missing', id);
  if (document) console.error('[debug] ws tenant', document.data.tenant, 'want', tenantKey, 'members', JSON.stringify(document.data.members));
  if (!document || document.data.tenant !== tenantKey) throw apiError(404, 'workspace_not_found', 'workspace not found');
  return document.data;
}

export function registerCollaborationRoutes(app: Express, config: ServiceConfig): void {
  // ---------------- comments and mentions ----------------
  app.post('/v1/capabilities/comments', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const dedupeKey = optionalString(body.idempotencyKey, 'idempotencyKey', 200);
    if (dedupeKey) {
      const existing = await queryDocuments<CommentRecord>(client, COLLECTIONS.comments, {
        where: { tenant: principal.tenantKey, dedupeKey }, limit: 1,
      });
      if (existing.items[0]) return res.json({ comment: existing.items[0].data, inbox: [], duplicate: true });
    }
    const comment: CommentRecord = {
      id: newId(),
      tenant: principal.tenantKey,
      createdBy: principal.subject,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      module: requiredString(body.module, 'module', 1, 64),
      entityType: requiredString(body.entityType, 'entityType', 1, 64),
      entityId: requiredString(body.entityId, 'entityId', 1, 256),
      body: requiredString(body.body, 'body', 1, 10_000),
      mentions: stringArray(body.mentions, 'mentions', 50),
      ...(dedupeKey ? { dedupeKey } : {}),
    };
    await client.base.createDocument(COLLECTIONS.comments, { id: comment.id, data: comment as unknown as Record<string, unknown> });
    const created: InboxRecord[] = [];
    for (const recipient of comment.mentions) {
      if (recipient === principal.subject) continue;
      const dedupeKey = `comment:${comment.id}:${recipient}`;
      const existing = await queryDocuments<InboxRecord>(client, COLLECTIONS.inbox, {
        where: { tenant: principal.tenantKey, dedupeKey }, limit: 1,
      });
      if (existing.items.length) continue;
      const prefsResult = await queryDocuments<PreferenceRecord>(client, COLLECTIONS.notificationPrefs, {
        where: { tenant: principal.tenantKey, subject: recipient }, limit: 1,
      });
      const prefs = prefsResult.items[0]?.data;
      const suppressed = !!prefs && (prefs.muted || inQuietHours(prefs));
      const item: InboxRecord = {
        id: newId(), tenant: principal.tenantKey, createdBy: principal.subject,
        createdAt: nowIso(), updatedAt: nowIso(), recipient,
        module: comment.module, kind: 'mention',
        title: `Mentioned in ${comment.entityType}`,
        body: comment.body.slice(0, 500),
        entityType: comment.entityType, entityId: comment.entityId,
        status: 'unread', dedupeKey, delivered: !suppressed,
      };
      await client.base.createDocument(COLLECTIONS.inbox, { id: item.id, data: item as unknown as Record<string, unknown> });
      created.push(item);
    }
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'collaboration.comment.create',
      correlationId: correlationIdOf(req), details: { commentId: comment.id, mentions: comment.mentions.length },
    });
    res.status(201).json({ comment, inbox: created });
  }));

  app.get('/v1/capabilities/comments', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const where: Record<string, unknown> = { tenant: principal.tenantKey };
    if (req.query.entityType) where.entityType = String(req.query.entityType);
    if (req.query.entityId) where.entityId = String(req.query.entityId);
    if (req.query.module) where.module = String(req.query.module);
    const result = await queryDocuments<CommentRecord>(client, COLLECTIONS.comments, {
      where, orderBy: { field: 'createdAt', direction: 'asc' }, limit: 500,
    });
    res.json({ items: result.items.map((item) => item.data), total: result.total });
  }));

  // ---------------- inbox ----------------
  app.get('/v1/capabilities/inbox', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const where: Record<string, unknown> = { tenant: principal.tenantKey, recipient: principal.subject };
    const status = String(req.query.status || '').trim();
    if (status) {
      if (!['unread', 'read', 'archived'].includes(status)) throw apiError(400, 'invalid_request', 'invalid inbox status');
      where.status = status;
    }
    if (req.query.module) where.module = String(req.query.module);
    const result = await queryDocuments<InboxRecord>(client, COLLECTIONS.inbox, {
      where, orderBy: { field: 'createdAt', direction: 'desc' }, limit: 200,
    });
    res.json({ items: result.items.map((item) => item.data), total: result.total, unread: result.items.filter((i) => i.data.status === 'unread').length });
  }));

  app.post('/v1/capabilities/inbox/:id/:action(read|archive)', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { record } = await getScoped<InboxRecord>(client, COLLECTIONS.inbox, String(req.params.id), principal, 'inbox_item_not_found');
    if (record.recipient !== principal.subject && !isAdmin(principal)) throw apiError(403, 'forbidden', 'this inbox item belongs to another user');
    const status = req.params.action === 'archive' ? 'archived' : 'read';
    const updated = await updateScoped(client, COLLECTIONS.inbox, record.id, principal, { status });
    res.json({ item: updated });
  }));

  app.get('/v1/capabilities/notification-preferences', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const result = await queryDocuments<PreferenceRecord>(client, COLLECTIONS.notificationPrefs, {
      where: { tenant: principal.tenantKey, subject: principal.subject }, limit: 1,
    });
    res.json({ preferences: result.items[0]?.data || {
      subject: principal.subject, channels: ['inbox'], muted: false, digest: 'instant',
    } });
  }));

  app.put('/v1/capabilities/notification-preferences', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const channels = stringArray(body.channels, 'channels', 10);
    if (channels.some((channel) => !['inbox', 'email', 'webhook', 'digest'].includes(channel))) {
      throw apiError(400, 'invalid_request', 'channels must be inbox, email, webhook or digest');
    }
    const quiet = body.quietHours && typeof body.quietHours === 'object' ? body.quietHours as Record<string, unknown> : undefined;
    if (quiet && (!Number.isInteger(Number(quiet.start)) || !Number.isInteger(Number(quiet.end))
      || Number(quiet.start) < 0 || Number(quiet.start) > 23 || Number(quiet.end) < 0 || Number(quiet.end) > 23)) {
      throw apiError(400, 'invalid_request', 'quietHours.start/end must be hours 0..23');
    }
    const result = await queryDocuments<PreferenceRecord>(client, COLLECTIONS.notificationPrefs, {
      where: { tenant: principal.tenantKey, subject: principal.subject }, limit: 1,
    });
    const existing = result.items[0];
    const data = {
      subject: principal.subject,
      channels: channels.length ? channels : ['inbox'],
      muted: body.muted === true,
      digest: ['instant', 'daily', 'weekly'].includes(String(body.digest)) ? String(body.digest) : 'instant',
      ...(quiet ? { quietHours: { start: Number(quiet.start), end: Number(quiet.end), timezone: String(quiet.timezone || 'UTC') } } : {}),
    };
    let saved: PreferenceRecord;
    if (existing) {
      saved = await updateScoped(client, COLLECTIONS.notificationPrefs, existing.id, principal, data as any);
    } else {
      saved = await createScoped(client, COLLECTIONS.notificationPrefs, principal, data as any) as unknown as PreferenceRecord;
    }
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'collaboration.preferences.update',
      correlationId: correlationIdOf(req), details: { muted: data.muted, digest: data.digest, channels: data.channels },
    });
    res.json({ preferences: saved });
  }));

  // ---------------- workspaces ----------------
  app.post('/v1/capabilities/workspaces', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const workspace = await createScoped(client, COLLECTIONS.workspaces, principal, {
      name: requiredString(body.name, 'name', 2, 160),
      description: optionalString(body.description, 'description', 1000),
      para: ['projects', 'areas', 'resources', 'archive'].includes(String(body.para)) ? String(body.para) : 'projects',
      visibility: body.visibility === 'private' ? 'private' : 'team',
      owner: principal.subject,
      members: [
        { subject: principal.subject, role: 'owner' },
        ...(Array.isArray(body.members) ? body.members.slice(0, 200).map((member: any) => ({
          subject: String(member?.subject || '').slice(0, 128),
          role: ['owner', 'editor', 'viewer'].includes(String(member?.role)) ? String(member.role) : 'viewer',
        })).filter((member: any) => member.subject) : []),
      ].filter((member, index, all) => all.findIndex((m) => m.subject === member.subject) === index),
    } as any) as unknown as WorkspaceRecord;
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'workspace.create',
      correlationId: correlationIdOf(req), details: { workspaceId: workspace.id },
    });
    res.status(201).json({ workspace });
  }));

  app.get('/v1/capabilities/workspaces', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const admin = isAdmin(principal);
    const result = await queryDocuments<WorkspaceRecord>(client, COLLECTIONS.workspaces, { limit: 1000 });
    const items = result.items.map((item) => item.data)
      .filter((ws) => admin || (ws.tenant === principal.tenantKey && canAccessWorkspace(ws, principal.subject, false)));
    res.json({ items, total: items.length });
  }));

  app.patch('/v1/capabilities/workspaces/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const ws = await loadWorkspace(client, String(req.params.id), principal.tenantKey);
    if (!canEditWorkspace(ws, principal.subject, isAdmin(principal))) throw apiError(403, 'forbidden', 'workspace editor permission required');
    const body = (req.body || {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = requiredString(body.name, 'name', 2, 160);
    if (body.description !== undefined) patch.description = optionalString(body.description, 'description', 1000);
    if (body.para !== undefined && ['projects', 'areas', 'resources', 'archive'].includes(String(body.para))) patch.para = String(body.para);
    if (body.visibility !== undefined) patch.visibility = body.visibility === 'private' ? 'private' : 'team';
    if (Array.isArray(body.members)) {
      const members = body.members.slice(0, 200).map((member: any) => ({
        subject: requiredString(member?.subject, 'member.subject', 1, 128),
        role: ['owner', 'editor', 'viewer'].includes(String(member?.role)) ? String(member.role) : 'viewer',
      }));
      patch.members = members;
    }
    const updated = await updateScoped(client, COLLECTIONS.workspaces, ws.id, principal, patch as any);
    res.json({ workspace: updated });
  }));

  app.delete('/v1/capabilities/workspaces/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const ws = await loadWorkspace(client, String(req.params.id), principal.tenantKey);
    if (!canEditWorkspace(ws, principal.subject, isAdmin(principal))) throw apiError(403, 'forbidden', 'workspace editor permission required');
    const pages = await queryDocuments<PageRecord>(client, COLLECTIONS.pages, { where: { workspaceId: ws.id }, limit: 1000 });
    for (const page of pages.items) await client.base.deleteDocument(COLLECTIONS.pages, page.id).catch(() => undefined);
    await client.base.deleteDocument(COLLECTIONS.workspaces, ws.id);
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'workspace.delete',
      correlationId: correlationIdOf(req), details: { workspaceId: ws.id },
    });
    res.json({ ok: true });
  }));

  // ---------------- wiki pages ----------------
  async function loadPage(client: any, id: string, tenant: string, subject: string, admin: boolean, write = false): Promise<{ page: PageRecord; ws: WorkspaceRecord }> {
    const document = await getDocumentOrNull<PageRecord>(client, COLLECTIONS.pages, id);
    if (!document || document.data.tenant !== tenant) throw apiError(404, 'page_not_found', 'page not found');
    const ws = await loadWorkspace(client, document.data.workspaceId, tenant);
    const allowed = write ? canEditWorkspace(ws, subject, admin) : canAccessWorkspace(ws, subject, admin);
    if (!allowed) throw apiError(404, 'page_not_found', 'page not found');
    return { page: document.data, ws };
  }

  function backlinksFor(page: PageRecord, all: PageRecord[]): Array<{ id: string; title: string }> {
    const needle = `[[${page.title}]]`.toLowerCase();
    return all.filter((candidate) => candidate.id !== page.id && candidate.markdown.toLowerCase().includes(needle))
      .map((candidate) => ({ id: candidate.id, title: candidate.title }));
  }

  app.post('/v1/capabilities/workspaces/:id/pages', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const ws = await loadWorkspace(client, String(req.params.id), principal.tenantKey);
    if (!canEditWorkspace(ws, principal.subject, isAdmin(principal))) throw apiError(403, 'forbidden', 'workspace editor permission required');
    const body = (req.body || {}) as Record<string, unknown>;
    const page = await createScoped(client, COLLECTIONS.pages, principal, {
      workspaceId: ws.id,
      title: requiredString(body.title, 'title', 1, 240),
      markdown: String(body.markdown || '').slice(0, 200_000),
      folder: ['projects', 'areas', 'resources', 'archive'].includes(String(body.folder)) ? String(body.folder) : ws.para,
      tags: stringArray(body.tags, 'tags', 30),
      versions: [],
      attachments: [],
    } as any) as unknown as PageRecord;
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'workspace.page.create',
      correlationId: correlationIdOf(req), details: { pageId: page.id, workspaceId: ws.id },
    });
    res.status(201).json({ page: { ...page, backlinks: [] } });
  }));

  app.get('/v1/capabilities/workspaces/:id/pages', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const ws = await loadWorkspace(client, String(req.params.id), principal.tenantKey);
    if (!canAccessWorkspace(ws, principal.subject, isAdmin(principal))) throw apiError(404, 'workspace_not_found', 'workspace not found');
    const where: Record<string, unknown> = { workspaceId: ws.id };
    if (req.query.folder) where.folder = String(req.query.folder);
    const result = await queryDocuments<PageRecord>(client, COLLECTIONS.pages, {
      where, orderBy: { field: 'updatedAt', direction: 'desc' }, limit: 1000,
    });
    res.json({ items: result.items.map((item) => item.data), total: result.total });
  }));

  app.get('/v1/capabilities/pages/:id', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { page, ws } = await loadPage(client, String(req.params.id), principal.tenantKey, principal.subject, isAdmin(principal));
    const all = await queryDocuments<PageRecord>(client, COLLECTIONS.pages, { where: { workspaceId: ws.id }, limit: 1000 });
    const attachments: PageRecord['attachments'] = [];
    for (const attachment of page.attachments) {
      const file = await getDocumentOrNull<any>(client, COLLECTIONS.files, attachment.fileId);
      if (file && file.data.tenant === principal.tenantKey && !file.data.deletedAt) attachments.push(attachment);
    }
    res.json({
      page: { ...page, attachments }, workspace: { id: ws.id, name: ws.name },
      backlinks: backlinksFor(page, all.items.map((item) => item.data)),
    });
  }));

  app.put('/v1/capabilities/pages/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { page } = await loadPage(client, String(req.params.id), principal.tenantKey, principal.subject, isAdmin(principal), true);
    const body = (req.body || {}) as Record<string, unknown>;
    const ifVersion = body.ifVersion === undefined ? undefined : Number(body.ifVersion);
    if (ifVersion !== undefined && (!Number.isInteger(ifVersion) || ifVersion < 0)) throw apiError(400, 'invalid_request', 'ifVersion must be a non-negative integer');
    const nextTitle = body.title !== undefined ? requiredString(body.title, 'title', 1, 240) : page.title;
    const nextMarkdown = body.markdown !== undefined ? String(body.markdown).slice(0, 200_000) : page.markdown;
    const versions = [...(page.versions || []), {
      version: (page.versions?.length || 0) + 1,
      title: page.title, markdown: page.markdown, at: nowIso(), by: principal.subject,
    }].slice(-50);
    const updated = await updateScoped(client, COLLECTIONS.pages, page.id, principal, {
      title: nextTitle, markdown: nextMarkdown, versions,
      ...(body.folder !== undefined && ['projects', 'areas', 'resources', 'archive'].includes(String(body.folder)) ? { folder: String(body.folder) } : {}),
      ...(body.tags !== undefined ? { tags: stringArray(body.tags, 'tags', 30) } : {}),
    } as any, ifVersion);
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'workspace.page.update',
      correlationId: correlationIdOf(req), details: { pageId: page.id, savedVersion: versions.length },
    });
    res.json({ page: updated });
  }));

  app.delete('/v1/capabilities/pages/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { page } = await loadPage(client, String(req.params.id), principal.tenantKey, principal.subject, isAdmin(principal), true);
    await client.base.deleteDocument(COLLECTIONS.pages, page.id);
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'workspace.page.delete',
      correlationId: correlationIdOf(req), details: { pageId: page.id },
    });
    res.json({ ok: true });
  }));

  app.post('/v1/capabilities/pages/:id/attachments', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { page } = await loadPage(client, String(req.params.id), principal.tenantKey, principal.subject, isAdmin(principal), true);
    const body = (req.body || {}) as Record<string, unknown>;
    const fileId = requiredString(body.fileId, 'fileId', 1, 128);
    const file = await getDocumentOrNull<any>(client, COLLECTIONS.files, fileId);
    if (!file || file.data.tenant !== principal.tenantKey) throw apiError(404, 'file_not_found', 'file not found');
    const attachment = {
      fileId, name: optionalString(body.name, 'name', 240) || file.data.name || fileId,
      ...(body.checksum !== undefined ? { checksum: String(body.checksum).slice(0, 128) } : {}),
      addedAt: nowIso(),
    };
    const attachments = [...(page.attachments || []).filter((item) => item.fileId !== fileId), attachment].slice(-100);
    const updated = await updateScoped(client, COLLECTIONS.pages, page.id, principal, { attachments } as any);
    res.status(201).json({ attachment, page: updated });
  }));

  app.get('/v1/capabilities/page-search', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) throw apiError(400, 'invalid_request', 'q is required');
    const workspaces = await queryDocuments<WorkspaceRecord>(client, COLLECTIONS.workspaces, { where: { tenant: principal.tenantKey }, limit: 1000 });
    const accessibleIds = new Set(workspaces.items.map((item) => item.data)
      .filter((ws) => canAccessWorkspace(ws, principal.subject, isAdmin(principal))).map((ws) => ws.id));
    const pages = await queryDocuments<PageRecord>(client, COLLECTIONS.pages, { where: { tenant: principal.tenantKey }, limit: 5000 });
    const items = pages.items.map((item) => item.data)
      .filter((page) => accessibleIds.has(page.workspaceId))
      .filter((page) => page.title.toLowerCase().includes(q) || page.markdown.toLowerCase().includes(q))
      .slice(0, 50)
      .map((page) => {
        const at = page.markdown.toLowerCase().indexOf(q);
        return {
          id: page.id, title: page.title, workspaceId: page.workspaceId,
          snippet: at >= 0 ? page.markdown.slice(Math.max(0, at - 60), at + 140) : page.markdown.slice(0, 160),
        };
      });
    res.json({ items, total: items.length });
  }));
}
