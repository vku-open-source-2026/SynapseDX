// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Notification capability over Tier-1 SynapseNotifications.
 *
 * Tier-2 owns reusable templates, recipient/channel mapping and a stable
 * outbox-free contract. Delivery, retries, backoff, deduplication and
 * preferences are Tier-1 concerns; Tier-2 stores no queue, provider key or
 * delivery state.
 */
import { Express } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { SynapseOneError } from '@synapseone/sdk';
import { isAdmin } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { parsePagination, setPageHeaders } from '../pagination';
import {
  COLLECTIONS, claimIdempotency, correlationIdOf, ensureCollections, getDocumentOrNull,
  idempotencyKeyOf, queryDocuments, recordAudit, requestFingerprint,
} from '../platform';
import { authenticatedReadContext, writeContext } from './shared';

export type NotificationChannel = 'email' | 'sms' | 'push' | 'webhook' | 'log';

const CHANNELS: NotificationChannel[] = ['email', 'sms', 'push', 'webhook', 'log'];

export interface NotificationTemplate {
  id: string;
  tenant: string;
  name: string;
  channel: NotificationChannel;
  subject?: string;
  body: string;
  locale?: string;
  createdAt: string;
  updatedAt: string;
}

interface Recipient {
  email?: string;
  phone?: string;
  pushToken?: string;
  url?: string;
  webhookUrl?: string;
  userId?: string;
}

interface NotificationRef {
  id: string;
  tenant: string;
  channel: NotificationChannel;
  template?: string;
  createdAt: string;
}

interface NotificationPreferenceRecord {
  id: string;
  tenant: string;
  recipient: string;
  channels: NotificationChannel[];
  unsubscribed: boolean;
  updatedAt: string;
}

function preferenceId(tenant: string, recipient: string): string {
  return createHash('sha256').update(`${tenant}|${recipient}`).digest('hex').slice(0, 40);
}

function recipientKeyOf(recipient: Recipient): string {
  if (recipient.userId) return `user:${recipient.userId}`;
  return recipient.email || recipient.phone || recipient.url || recipient.webhookUrl || recipient.pushToken || 'unknown';
}

function channelOf(raw: unknown): NotificationChannel {
  const channel = String(raw || '').toLowerCase();
  if (!CHANNELS.includes(channel as NotificationChannel)) {
    throw apiError(400, 'invalid_request', `channel must be one of ${CHANNELS.join('|')}`, { field: 'channel' });
  }
  return channel as NotificationChannel;
}

function channelsOf(body: Record<string, unknown>): NotificationChannel[] {
  if (Array.isArray(body.channels)) {
    if (!body.channels.length || body.channels.length > 5) {
      throw apiError(400, 'invalid_request', 'channels must contain 1..5 entries');
    }
    return [...new Set(body.channels.map(channelOf))];
  }
  return [channelOf(body.channel)];
}

function templateId(raw: unknown): string {
  const id = String(raw || '').trim();
  if (!id) throw apiError(400, 'field_required', 'template is required', { field: 'template' });
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw apiError(400, 'invalid_request', 'template id must match [A-Za-z0-9_-]{1,80}');
  return id;
}

function recipientOf(body: Record<string, unknown>, channels: NotificationChannel[]): Recipient {
  const raw = body.recipient;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    const recipient: Recipient = {};
    for (const key of ['email', 'phone', 'pushToken', 'url', 'webhookUrl', 'userId'] as const) {
      if (value[key] !== undefined) recipient[key] = String(value[key]);
    }
    if (Object.keys(recipient).length) return recipient;
  }
  const to = String(body.to || '').trim();
  if (!to) throw apiError(400, 'field_required', 'recipient or to is required', { field: 'recipient' });
  if (channels.includes('email')) return { email: to };
  if (channels.includes('sms')) return { phone: to };
  if (channels.includes('push')) return { pushToken: to };
  if (channels.includes('webhook')) return { url: to };
  return { userId: to };
}

function visible(template: NotificationTemplate, principal: { tenantKey: string; scopes: string[] }): boolean {
  return isAdmin(principal as any) || template.tenant === principal.tenantKey;
}

async function loadTemplate(client: any, id: string, principal: { tenantKey: string; scopes: string[] }): Promise<NotificationTemplate> {
  const found = await getDocumentOrNull<NotificationTemplate>(client, COLLECTIONS.notificationTemplates, id);
  if (!found || !visible(found.data, principal)) throw apiError(404, 'template_not_found', 'notification template not found');
  return found.data;
}

function templateView(template: NotificationTemplate): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    channel: template.channel,
    subject: template.subject || '',
    body: template.body,
    ...(template.locale ? { locale: template.locale } : {}),
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

function notificationView(record: any): Record<string, unknown> {
  const attempts = Array.isArray(record?.attempts) ? record.attempts : [];
  const last = attempts.length ? attempts[attempts.length - 1] : undefined;
  return {
    id: String(record?.id || ''),
    channel: record?.channel,
    status: record?.status,
    recipient: record?.recipient,
    subject: record?.subject || '',
    attempts: attempts.length,
    ...(last?.error ? { error: last.error } : {}),
    ...(record?.deadReason ? { deadReason: record.deadReason } : {}),
    createdAt: record?.createdAt,
    updatedAt: record?.updatedAt,
    nextAttemptAt: record?.nextAttemptAt,
  };
}

function mapDeliveryError(error: unknown): never {
  if (error instanceof SynapseOneError) {
    if (error.status === 404) throw apiError(404, 'notification_not_found', 'notification not found');
    if (error.status === 409) throw apiError(409, 'notification_not_cancellable', 'notification is not cancellable');
    if (error.status === 413) throw apiError(413, 'payload_too_large', 'the notification payload is too large');
    if (error.status === 429) throw apiError(429, 'rate_limited' as any, 'the notification rate limit was exceeded');
  }
  throw error;
}

export function registerNotificationRoutes(app: Express, config: ServiceConfig): void {
  // ---- templates ----
  app.get('/v1/capabilities/notifications/templates', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const pagination = parsePagination(req, config.maxPageSize);
    const result = await queryDocuments<NotificationTemplate>(client, COLLECTIONS.notificationTemplates, {
      where: { tenant: principal.tenantKey },
      orderBy: { field: 'name', direction: 'asc' },
      limit: pagination.limit,
      offset: pagination.offset,
    });
    setPageHeaders(res, { total: result.total, limit: pagination.limit, offset: pagination.offset, nextCursor: result.nextCursor });
    res.json({
      items: result.items.map((item) => templateView(item.data)),
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
      nextCursor: result.nextCursor,
    });
  }));

  app.post('/v1/capabilities/notifications/templates', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const name = String(body.name || '').trim();
    if (!name) throw apiError(400, 'field_required', 'name is required', { field: 'name' });
    const channel = channelOf(body.channel);
    const text = String(body.body || '').trim();
    if (!text) throw apiError(400, 'field_required', 'body is required', { field: 'body' });
    if (text.length > 100_000) throw apiError(413, 'payload_too_large', 'template body exceeds 100000 characters');
    const subject = body.subject === undefined ? undefined : String(body.subject).slice(0, 500);
    const locale = body.locale === undefined ? undefined : String(body.locale);
    if (locale && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(locale)) {
      throw apiError(400, 'template_invalid', 'locale must be a BCP-47 language tag');
    }
    const id = body.id === undefined ? `tpl-${randomUUID()}` : templateId(body.id);
    await ensureCollections(client);
    const now = new Date().toISOString();
    const template: NotificationTemplate = {
      id, tenant: principal.tenantKey, name, channel,
      ...(subject ? { subject } : {}), body: text,
      ...(locale ? { locale } : {}),
      createdAt: now, updatedAt: now,
    };
    try {
      await client.base.createDocument(COLLECTIONS.notificationTemplates, {
        id, data: template as unknown as Record<string, unknown>,
      });
    } catch (error) {
      if (error instanceof SynapseOneError && error.status === 409) {
        throw apiError(409, 'template_invalid', 'a template with this id already exists');
      }
      throw error;
    }
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'notification.template.create',
      correlationId: correlationIdOf(req), details: { id, channel },
    });
    res.status(201).json(templateView(template));
  }));

  app.get('/v1/capabilities/notifications/templates/:id', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const template = await loadTemplate(client, String(req.params.id), principal);
    res.json(templateView(template));
  }));

  app.patch('/v1/capabilities/notifications/templates/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const found = await getDocumentOrNull<NotificationTemplate>(client, COLLECTIONS.notificationTemplates, String(req.params.id));
    if (!found || !visible(found.data, principal)) throw apiError(404, 'template_not_found', 'notification template not found');
    const body = (req.body || {}) as Record<string, unknown>;
    const updated: NotificationTemplate = {
      ...found.data,
      ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
      ...(body.channel !== undefined ? { channel: channelOf(body.channel) } : {}),
      ...(body.subject !== undefined ? { subject: String(body.subject).slice(0, 500) } : {}),
      ...(body.body !== undefined ? { body: String(body.body) } : {}),
      ...(body.locale !== undefined ? { locale: String(body.locale) } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (!updated.name || !updated.body) throw apiError(400, 'template_invalid', 'name and body are required');
    await client.base.updateDocument(COLLECTIONS.notificationTemplates, found.data.id, {
      data: updated as unknown as Record<string, unknown>,
      ...(found.version ? { ifVersion: found.version } : {}),
    });
    res.json(templateView(updated));
  }));

  app.delete('/v1/capabilities/notifications/templates/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const found = await getDocumentOrNull<NotificationTemplate>(client, COLLECTIONS.notificationTemplates, String(req.params.id));
    if (!found || !visible(found.data, principal)) throw apiError(404, 'template_not_found', 'notification template not found');
    await client.base.deleteDocument(COLLECTIONS.notificationTemplates, found.data.id);
    res.status(204).end();
  }));

  // ---- preferences (Tier-2 scoped; enforced before every send) ----
  const readPreference = async (client: any, tenant: string, recipient: string): Promise<NotificationPreferenceRecord> => {
    const id = preferenceId(tenant, recipient);
    const found = await getDocumentOrNull<NotificationPreferenceRecord>(client, COLLECTIONS.notificationPreferences, id);
    return found?.data || { id, tenant, recipient, channels: [], unsubscribed: false, updatedAt: new Date(0).toISOString() };
  };

  app.get('/v1/capabilities/notifications/preferences/:recipient', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const preference = await readPreference(client, principal.tenantKey, String(req.params.recipient));
    res.setHeader('cache-control', 'no-store');
    res.json(preference);
  }));

  app.put('/v1/capabilities/notifications/preferences/:recipient', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const channels = body.channels === undefined
      ? []
      : (Array.isArray(body.channels) ? body.channels.map(channelOf) : [channelOf(body.channels)]);
    const recipient = String(req.params.recipient);
    const record: NotificationPreferenceRecord = {
      id: preferenceId(principal.tenantKey, recipient),
      tenant: principal.tenantKey,
      recipient,
      channels,
      unsubscribed: body.unsubscribed === true,
      updatedAt: new Date().toISOString(),
    };
    await ensureCollections(client);
    const existing = await getDocumentOrNull<NotificationPreferenceRecord>(client, COLLECTIONS.notificationPreferences, record.id);
    if (existing) {
      await client.base.updateDocument(COLLECTIONS.notificationPreferences, record.id, {
        data: record as unknown as Record<string, unknown>,
        ...(existing.version ? { ifVersion: existing.version } : {}),
      });
    } else {
      await client.base.createDocument(COLLECTIONS.notificationPreferences, { id: record.id, data: record as unknown as Record<string, unknown> });
    }
    res.json(record);
  }));

  app.post('/v1/capabilities/notifications/unsubscribe', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const recipient = String((req.body || {}).recipient || '').trim();
    if (!recipient) throw apiError(400, 'field_required', 'recipient is required', { field: 'recipient' });
    const existing = await readPreference(client, principal.tenantKey, recipient);
    const record: NotificationPreferenceRecord = { ...existing, unsubscribed: true, updatedAt: new Date().toISOString() };
    await ensureCollections(client);
    const found = await getDocumentOrNull<NotificationPreferenceRecord>(client, COLLECTIONS.notificationPreferences, record.id);
    if (found) {
      await client.base.updateDocument(COLLECTIONS.notificationPreferences, record.id, {
        data: record as unknown as Record<string, unknown>,
        ...(found.version ? { ifVersion: found.version } : {}),
      });
    } else {
      await client.base.createDocument(COLLECTIONS.notificationPreferences, { id: record.id, data: record as unknown as Record<string, unknown> });
    }
    res.json(record);
  }));

  // ---- send / status ----
  const send = handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const idempotencyKey = idempotencyKeyOf(req) || (body.idempotencyKey ? String(body.idempotencyKey) : undefined);
    const claim = await claimIdempotency(
      client, config, principal.tenantKey, idempotencyKey,
      requestFingerprint('POST', req.path, body),
    );
    if (claim?.replay) {
      res.status(claim.replay.status).json(claim.replay.body);
      return;
    }
    try {
      let channels = body.channel !== undefined || body.channels !== undefined ? channelsOf(body) : undefined;
      let subject = body.subject === undefined ? undefined : String(body.subject).slice(0, 500);
      let text = String(body.body ?? body.text ?? '').trim();
      let template: NotificationTemplate | undefined;
      if (body.template !== undefined) {
        template = await loadTemplate(client, templateId(body.template), principal);
        if (channels && !channels.every((channel) => channel === template!.channel)) {
          throw apiError(400, 'template_invalid', 'the requested channel does not match the template channel', {
            templateChannel: template.channel,
          });
        }
        channels = channels || [template.channel];
        text = text || template.body;
        subject = subject || template.subject;
      }
      channels = channels || (text ? ['email' as NotificationChannel] : []);
      if (!channels.length) throw apiError(400, 'field_required', 'channel or template is required');
      if (!text) throw apiError(400, 'field_required', 'body or template is required', { field: 'body' });
      const recipient = recipientOf(body, channels);
      const preference = await readPreference(client, principal.tenantKey, recipientKeyOf(recipient));
      if (preference.unsubscribed) {
        throw apiError(409, 'notification_suppressed', 'this recipient has unsubscribed from notifications');
      }
      if (preference.channels.length) {
        channels = channels.filter((channel) => preference.channels.includes(channel));
        if (!channels.length) {
          throw apiError(409, 'notification_suppressed', 'this recipient has disabled every requested channel', {
            enabled: preference.channels,
          });
        }
      }
      const data = (body.variables && typeof body.variables === 'object'
        ? body.variables
        : body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
      const metadata = {
        ...data,
        ...(body.locale ? { locale: String(body.locale) } : {}),
        ...(body.priority ? { priority: String(body.priority) } : {}),
        ...(template ? { template: template.id } : {}),
      };
      let result: any;
      try {
        result = await client.notifications.send({
          channels,
          recipient: recipient as any,
          ...(subject ? { subject } : {}),
          body: text,
          data: metadata,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
      } catch (error) {
        mapDeliveryError(error);
      }
      const notifications = Array.isArray(result?.notifications) ? result.notifications : [];
      // Index the delivery ids by Tier-2 tenant: Tier-1 is called with the
      // platform credential, so this index is the cross-product boundary.
      await ensureCollections(client);
      for (const record of notifications) {
        if (!record?.id) continue;
        const ref: NotificationRef = {
          id: String(record.id), tenant: principal.tenantKey, channel: record.channel,
          ...(template ? { template: template.id } : {}), createdAt: new Date().toISOString(),
        };
        try {
          await client.base.createDocument(COLLECTIONS.notificationRefs, { id: ref.id, data: ref as unknown as Record<string, unknown> });
        } catch (error) {
          if (!(error instanceof SynapseOneError && error.status === 409)) throw error;
        }
      }
      await recordAudit(client, config, {
        actor: principal.subject, tenant: principal.tenantKey, action: 'notification.send',
        correlationId: correlationIdOf(req), details: { channels, template: template?.id, count: notifications.length },
      });
      const payload = { notifications: notifications.map(notificationView), requested: channels.length };
      res.status(202).json(payload);
      await claim?.complete(202, payload);
    } catch (error) {
      await claim?.release();
      throw error;
    }
  });

  app.post('/v1/capabilities/notifications', send);
  app.post('/v1/capabilities/notifications/send', send);

  app.get('/v1/capabilities/notifications', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const status = req.query.status === undefined ? undefined : String(req.query.status);
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw apiError(400, 'invalid_limit', 'limit must be 1..200');
    const refs = await queryDocuments<NotificationRef>(client, COLLECTIONS.notificationRefs, {
      where: { tenant: principal.tenantKey },
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit,
    });
    const items: any[] = [];
    for (const ref of refs.items) {
      try {
        const record = await client.notifications.get(ref.data.id);
        if (!status || (record as any).status === status) items.push(notificationView(record));
      } catch (error) {
        if (!(error instanceof SynapseOneError && error.status === 404)) throw error;
      }
    }
    res.json({ items, count: items.length });
  }));

  app.get('/v1/capabilities/notifications/:id', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const id = String(req.params.id);
    const ref = await getDocumentOrNull<NotificationRef>(client, COLLECTIONS.notificationRefs, id);
    if (!ref || (ref.data.tenant !== principal.tenantKey && !isAdmin(principal))) {
      throw apiError(404, 'notification_not_found', 'notification not found');
    }
    let record: any;
    try {
      record = await client.notifications.get(id);
    } catch (error) {
      mapDeliveryError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.json(notificationView(record));
  }));

  app.post('/v1/capabilities/notifications/:id/cancel', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const id = String(req.params.id);
    const ref = await getDocumentOrNull<NotificationRef>(client, COLLECTIONS.notificationRefs, id);
    if (!ref || (ref.data.tenant !== principal.tenantKey && !isAdmin(principal))) {
      throw apiError(404, 'notification_not_found', 'notification not found');
    }
    let record: any;
    try {
      record = await client.notifications.cancel(id);
    } catch (error) {
      mapDeliveryError(error);
    }
    res.json(notificationView(record));
  }));
}
