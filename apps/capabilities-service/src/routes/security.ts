// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Shared security-provider capability.
 *
 * Tier-3 products must not hold CAPTCHA provider secrets or call the provider
 * directly. This adapter keeps the secret in Tier 2 and returns a normalized
 * verification result to any product.
 */
import { Express } from 'express';
import { authenticate } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';

const TURNSTILE_DEPENDENCY = {
  dependency: 'tier2-turnstile',
  operation: 'configure SYNAPSEDX_TURNSTILE_SECRET_KEY',
};

export function registerSecurityRoutes(app: Express, config: ServiceConfig): void {
  app.post('/v1/capabilities/security/turnstile/verify', handler(async (req, res) => {
    await authenticate(req, config, true);
    const body = (req.body || {}) as Record<string, unknown>;
    if (!config.turnstile) {
      res.json({ ok: false, configured: false, error: 'turnstile_not_configured' });
      return;
    }
    const token = String(body.token || body['cf-turnstile-response'] || '').trim();
    if (!token) throw apiError(400, 'turnstile_token_required', 'a Turnstile token is required');
    if (token.length > 4096) throw apiError(400, 'invalid_request', 'the Turnstile token is too long');
    const remoteip = String(body.remoteip || body.remoteIp || '').trim();
    if (remoteip && remoteip.length > 64) throw apiError(400, 'invalid_request', 'remoteip is too long');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(config.requestTimeoutMs, 10_000));
    try {
      const response = await fetch(config.turnstile.verifyUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'SynapseDX/0.3',
        },
        body: new URLSearchParams({
          secret: config.turnstile.secret,
          response: token,
          ...(remoteip ? { remoteip } : {}),
        }).toString(),
        signal: controller.signal,
      });
      if (!response.ok) {
        res.status(503).json({ ok: false, configured: true, error: 'turnstile_unavailable', ...TURNSTILE_DEPENDENCY });
        return;
      }
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!payload || payload.success !== true) {
        res.json({
          ok: false,
          configured: true,
          error: 'turnstile_failed',
          ...(Array.isArray(payload?.['error-codes']) ? { errorCodes: payload?.['error-codes'] } : {}),
        });
        return;
      }
      res.json({ ok: true, configured: true });
    } catch {
      res.status(503).json({ ok: false, configured: true, error: 'turnstile_unavailable', ...TURNSTILE_DEPENDENCY });
    } finally {
      clearTimeout(timer);
    }
  }));
}
