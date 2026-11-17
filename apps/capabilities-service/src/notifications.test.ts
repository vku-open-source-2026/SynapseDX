// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startHarness } from './testing/harness';

test('notification templates, sends, status, cancellation and preferences are tenant-scoped', async () => {
  const harness = await startHarness();
  try {
    const template = await api(harness, '/v1/capabilities/notifications/templates', {
      method: 'POST', token: 'admin-token',
      body: {
        id: 'hazard-alert', name: 'Hazard alert', channel: 'email',
        subject: 'Hazard in {{district}}', body: 'Level {{level}} hazard reported in {{district}}.',
        locale: 'vi-VN',
      },
    });
    assert.equal(template.status, 201);
    assert.equal(template.body.channel, 'email');

    const templates = await api(harness, '/v1/capabilities/notifications/templates', { token: 'admin-token' });
    assert.equal(templates.status, 200);
    assert.equal(templates.body.total, 1);

    const updated = await api(harness, '/v1/capabilities/notifications/templates/hazard-alert', {
      method: 'PATCH', token: 'admin-token', body: { body: 'Hazard {{level}} in {{district}}.' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.body, 'Hazard {{level}} in {{district}}.');

    const send = await api(harness, '/v1/capabilities/notifications/send', {
      method: 'POST', token: 'admin-token',
      body: {
        template: 'hazard-alert', to: 'citizen@example.test',
        variables: { district: 'Hai Chau', level: 3 },
        idempotencyKey: 'alert-0001',
      },
    });
    assert.equal(send.status, 202);
    assert.equal(send.body.notifications.length, 1);
    const notificationId = send.body.notifications[0].id;
    assert.equal(send.body.notifications[0].channel, 'email');
    assert.equal(send.body.notifications[0].status, 'queued');

    const replay = await api(harness, '/v1/capabilities/notifications/send', {
      method: 'POST', token: 'admin-token',
      body: {
        template: 'hazard-alert', to: 'citizen@example.test',
        variables: { district: 'Hai Chau', level: 3 },
        idempotencyKey: 'alert-0001',
      },
    });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.notifications[0].id, notificationId);

    const status = await api(harness, `/v1/capabilities/notifications/${notificationId}`, { token: 'admin-token' });
    assert.equal(status.status, 200);
    assert.equal(status.body.id, notificationId);
    assert.equal(status.body.recipient.email, 'citizen@example.test');
    assert.equal(status.body.subject, 'Hazard in {{district}}');

    const list = await api(harness, '/v1/capabilities/notifications?limit=10', { token: 'admin-token' });
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 1);

    const otherTenant = await api(harness, `/v1/capabilities/notifications/${notificationId}`, { token: 'other-token' });
    assert.equal(otherTenant.status, 404);
    assert.equal(otherTenant.body.error.code, 'notification_not_found');
    const otherTemplate = await api(harness, '/v1/capabilities/notifications/templates/hazard-alert', { token: 'other-token' });
    assert.equal(otherTemplate.status, 404);

    const cancel = await api(harness, `/v1/capabilities/notifications/${notificationId}/cancel`, {
      method: 'POST', token: 'admin-token',
    });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.status, 'cancelled');

    const preference = await api(harness, '/v1/capabilities/notifications/preferences/citizen@example.test', { token: 'admin-token' });
    assert.equal(preference.status, 200);
    assert.equal(preference.body.unsubscribed, false);

    const unsubscribe = await api(harness, '/v1/capabilities/notifications/preferences/citizen@example.test', {
      method: 'PUT', token: 'admin-token', body: { unsubscribed: true },
    });
    assert.equal(unsubscribe.status, 200);
    assert.equal(unsubscribe.body.unsubscribed, true);

    const suppressed = await api(harness, '/v1/capabilities/notifications/send', {
      method: 'POST', token: 'admin-token',
      body: { channel: 'email', to: 'citizen@example.test', body: 'hello' },
    });
    assert.equal(suppressed.status, 409);
    assert.equal(suppressed.body.error.code, 'notification_suppressed');

    const unsubscribeEndpoint = await api(harness, '/v1/capabilities/notifications/unsubscribe', {
      method: 'POST', token: 'admin-token', body: { recipient: 'other@example.test' },
    });
    assert.equal(unsubscribeEndpoint.status, 200);
    assert.equal(unsubscribeEndpoint.body.unsubscribed, true);

    const deleted = await api(harness, '/v1/capabilities/notifications/templates/hazard-alert', {
      method: 'DELETE', token: 'admin-token',
    });
    assert.equal(deleted.status, 204);
  } finally {
    await harness.close();
  }
});

test('notification channel validation and explicit channels fan out through Tier-1', async () => {
  const harness = await startHarness();
  try {
    const foreignSend = await api(harness, '/v1/capabilities/notifications/send', {
      method: 'POST', token: 'user-token', body: { channel: 'email', to: 'citizen@example.test', body: 'hello' },
    });
    assert.equal(foreignSend.status, 403);
    assert.equal(foreignSend.body.error.code, 'recipient_not_allowed');
    const foreignPreference = await api(harness, '/v1/capabilities/notifications/preferences/citizen@example.test', { token: 'user-token' });
    assert.equal(foreignPreference.status, 403);
    const ownPreference = await api(harness, '/v1/capabilities/notifications/preferences/user-1', {
      method: 'PUT', token: 'user-token', body: { channels: ['email'] },
    });
    assert.equal(ownPreference.status, 200);
    assert.equal(ownPreference.body.recipient, 'user-1');
    const ownSend = await api(harness, '/v1/capabilities/notifications/send', {
      method: 'POST', token: 'user-token',
      body: { channel: 'email', to: 'user-1', body: 'self notification' },
    });
    assert.equal(ownSend.status, 202);

    const invalid = await api(harness, '/v1/capabilities/notifications/send', {
      method: 'POST', token: 'admin-token', body: { channel: 'fax', to: 'x', body: 'hello' },
    });
    assert.equal(invalid.status, 400);

    const missingBody = await api(harness, '/v1/capabilities/notifications/send', {
      method: 'POST', token: 'admin-token', body: { channel: 'sms', to: '+840000' },
    });
    assert.equal(missingBody.status, 400);
    assert.equal(missingBody.body.error.code, 'field_required');

    const fanout = await api(harness, '/v1/capabilities/notifications/send', {
      method: 'POST', token: 'admin-token',
      body: {
        channels: ['email', 'sms'], recipient: { email: 'a@example.test', phone: '+840000' },
        subject: 'Alert', body: 'Evacuate {{area}}', variables: { area: 'Hai Chau' },
        priority: 'high', locale: 'vi-VN',
      },
    });
    assert.equal(fanout.status, 202);
    assert.equal(fanout.body.notifications.length, 2);
    assert.deepEqual(fanout.body.notifications.map((item: any) => item.channel).sort(), ['email', 'sms']);
  } finally {
    await harness.close();
  }
});
