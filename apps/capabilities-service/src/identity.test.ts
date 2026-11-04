// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startHarness } from './testing/harness';

test('identity capability covers register, password login, change/reset, verification and sessions', async () => {
  const harness = await startHarness();
  try {
    const register = await api(harness, '/v1/capabilities/auth/register', {
      method: 'POST',
      body: { email: 'operator@example.test', password: 'initial-password', displayName: 'Operator' },
    });
    assert.equal(register.status, 201);
    assert.ok(register.body.accessToken);
    assert.equal(register.body.user.email, 'operator@example.test');

    const wrong = await api(harness, '/v1/capabilities/auth/login', {
      method: 'POST', body: { email: 'operator@example.test', password: 'nope' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'invalid_credentials');

    const login = await api(harness, '/v1/capabilities/auth/login', {
      method: 'POST', body: { email: 'operator@example.test', password: 'initial-password' },
    });
    assert.equal(login.status, 200);
    const accessToken = login.body.accessToken as string;

    const me = await api(harness, '/v1/capabilities/auth/me', { token: accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get('cache-control'), 'no-store');

    const refresh = await api(harness, '/v1/capabilities/auth/refresh', {
      method: 'POST', body: { refreshToken: login.body.refreshToken },
    });
    assert.equal(refresh.status, 200);
    assert.ok(refresh.body.accessToken);
    assert.notEqual(refresh.body.refreshToken, login.body.refreshToken);

    const oidcCallback = await api(harness, '/v1/capabilities/auth/oidc/callback', {
      method: 'POST', body: { code: 'code-1', state: 'signed-state' },
    });
    assert.equal(oidcCallback.status, 200);
    assert.equal(oidcCallback.body.accessToken, 'oidc-access');

    const logout = await api(harness, '/v1/capabilities/auth/logout', {
      method: 'POST', body: { refreshToken: refresh.body.refreshToken },
    });
    assert.equal(logout.status, 200);

    const sessions = await api(harness, '/v1/capabilities/auth/sessions', { token: accessToken });
    assert.equal(sessions.status, 200);
    assert.equal(sessions.body.length, 2);
    const revoke = await api(harness, '/v1/capabilities/auth/sessions/session-1', { method: 'DELETE', token: accessToken });
    assert.equal(revoke.status, 200);

    const changed = await api(harness, '/v1/capabilities/auth/password/change', {
      method: 'POST', token: accessToken,
      body: { currentPassword: 'initial-password', newPassword: 'next-password' },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.ok, true);

    const oldLogin = await api(harness, '/v1/capabilities/auth/login', {
      method: 'POST', body: { email: 'operator@example.test', password: 'initial-password' },
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await api(harness, '/v1/capabilities/auth/login', {
      method: 'POST', body: { email: 'operator@example.test', password: 'next-password' },
    });
    assert.equal(newLogin.status, 200);

    const forgot = await api(harness, '/v1/capabilities/auth/password/forgot', {
      method: 'POST', body: { email: 'operator@example.test' },
    });
    assert.equal(forgot.status, 202);
    assert.equal(forgot.headers.get('cache-control'), 'no-store');
    assert.ok(forgot.body.resetToken);

    const reset = await api(harness, '/v1/capabilities/auth/password/reset', {
      method: 'POST', body: { token: forgot.body.resetToken, newPassword: 'reset-password' },
    });
    assert.equal(reset.status, 200);
    const afterReset = await api(harness, '/v1/capabilities/auth/login', {
      method: 'POST', body: { email: 'operator@example.test', password: 'reset-password' },
    });
    assert.equal(afterReset.status, 200);

    const verify = await api(harness, '/v1/capabilities/auth/email/verify', {
      method: 'POST', body: { token: 'verify-token-1' },
    });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.emailVerified, true);

    const resend = await api(harness, '/v1/capabilities/auth/email/verify/request', {
      method: 'POST', token: accessToken,
    });
    assert.equal(resend.status, 200);
    assert.ok(resend.body.emailVerificationToken);

    const anonymousChange = await api(harness, '/v1/capabilities/auth/password/change', {
      method: 'POST', body: { currentPassword: 'a', newPassword: 'b' },
    });
    assert.equal(anonymousChange.status, 401);
  } finally {
    await harness.close();
  }
});

test('login/register/OIDC are bound to the deployment organization', async () => {
  const harness = await startHarness({ SYNAPSEDX_AUTH_ORG_SLUG: 'acme' });
  try {
    const badOrg = await api(harness, '/v1/capabilities/auth/login', {
      method: 'POST', body: { email: 'user@example.test', orgSlug: 'other-org' },
    });
    assert.equal(badOrg.status, 403);
    assert.equal(badOrg.body.error.code, 'org_not_allowed');

    const bound = await api(harness, '/v1/capabilities/auth/login', {
      method: 'POST', body: { email: 'user@example.test', orgSlug: 'acme' },
    });
    assert.equal(bound.status, 200);

    const register = await api(harness, '/v1/capabilities/auth/register', {
      method: 'POST', body: { email: 'new@example.test', password: 'password-1', orgSlug: 'acme' },
    });
    assert.equal(register.status, 201);

    const oidc = await api(harness, '/v1/capabilities/auth/oidc/start?org=acme');
    assert.equal(oidc.status, 200);
    assert.ok(oidc.body.authorizeUrl);
    const redirect = await api(harness, '/v1/capabilities/auth/oidc/start?org=acme&redirect=true', { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), 'https://idp.example/authorize');
  } finally {
    await harness.close();
  }
});

test('delegated token exchange requires a service credential and an allowed audience', async () => {
  const harness = await startHarness();
  try {
    const userExchange = await api(harness, '/v1/capabilities/auth/exchange', {
      method: 'POST', token: 'user-token', body: { userId: 'user-1' },
    });
    assert.equal(userExchange.status, 403);
    assert.equal(userExchange.body.error.code, 'exchange_forbidden');

    const noScope = await api(harness, '/v1/capabilities/auth/exchange', {
      method: 'POST', apiKey: 'city-key', body: { userId: 'user-1' },
    });
    assert.equal(noScope.status, 403);

    const badAudience = await api(harness, '/v1/capabilities/auth/exchange', {
      method: 'POST', apiKey: 'service-key', body: { userId: 'user-1', audience: 'someone-else' },
    });
    assert.equal(badAudience.status, 403);
    assert.equal(badAudience.body.error.code, 'audience_not_allowed');

    const ok = await api(harness, '/v1/capabilities/auth/exchange', {
      method: 'POST', apiKey: 'service-key',
      body: { userId: 'user-1', audience: 'synapsecity', scopes: ['read'] },
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.delegated, true);
    assert.equal(ok.body.audience, 'synapsecity');
    assert.equal(harness.fake.exchanges.length, 1);
    assert.equal(harness.fake.exchanges[0].audience, 'synapsecity');
  } finally {
    await harness.close();
  }
});
