// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Provider-neutral search/geocoding capability.
 *
 * The operator configures one licensed provider (VietMap preset or any
 * compatible REST adapter) and the credential stays server-side. City and SOS
 * call the same normalized contract, so neither product needs a provider key
 * or a duplicate integration.
 *
 * Adapter contract (generic provider):
 *   GET {base}/autocomplete?q=&limit=&focus=   -> {results: [...]} or [...]
 *   GET {base}/geocode?address=                -> {results: [...]} or [...]
 *   GET {base}/reverse?lat=&lon=               -> {results: [...]} or [...]
 *   GET {base}/place?id=                       -> object or [...]
 * Results are normalized to `{id,label,address,lat,lon}`; the raw provider
 * object is preserved under `raw` for provider-specific fields.
 */
import { Express } from 'express';
import { authenticate } from '../auth';
import { ServiceConfig } from '../config';
import { ApiError, apiError } from '../errors';
import { handler } from '../http';
import { stringParam } from '../pagination';

const GEO_DEPENDENCY = {
  dependency: 'tier2-geocoder',
  operation: 'configure SYNAPSEDX_GEOCODER_PROVIDER/BASE_URL/API_KEY with a licensed provider',
  tracking: 'https://github.com/vku-open-source-2026/SynapseDX/issues/17',
};

export interface GeoItem {
  id?: string;
  label?: string;
  address?: string;
  lat?: number;
  lon?: number;
  raw?: unknown;
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Normalize VietMap, generic `{results}` and bare-array provider shapes. */
export function normalizeGeoResults(payload: unknown): GeoItem[] {
  const body = payload as any;
  const list = Array.isArray(body)
    ? body
    : Array.isArray(body?.results)
      ? body.results
      : Array.isArray(body?.data)
        ? body.data
        : body && typeof body === 'object' && (body.display || body.address || body.lat)
          ? [body]
          : [];
  return list.map((entry: any) => {
    const lat = numberValue(entry?.lat ?? entry?.latitude ?? entry?.location?.lat);
    const lon = numberValue(entry?.lon ?? entry?.lng ?? entry?.longitude ?? entry?.location?.lon);
    const address = entry?.address ?? entry?.display_address
      ?? (Array.isArray(entry?.boundaries) ? entry.boundaries.map((b: any) => b?.full_name || b?.name).filter(Boolean).join(', ') : undefined);
    return {
      ...(entry?.ref_id || entry?.id ? { id: String(entry.ref_id || entry.id) } : {}),
      ...(entry?.display || entry?.label || entry?.name ? { label: String(entry.display || entry.label || entry.name) } : {}),
      ...(address ? { address: String(address) } : {}),
      ...(lat !== undefined ? { lat } : {}),
      ...(lon !== undefined ? { lon } : {}),
      raw: entry,
    };
  });
}

async function providerCall(
  config: ServiceConfig,
  path: string,
  query: Record<string, string | undefined>,
): Promise<unknown> {
  const geocoder = config.geocoder;
  if (!geocoder) {
    throw apiError(503, 'geocoder_unavailable', 'no geocoder provider is configured for this deployment', GEO_DEPENDENCY);
  }
  const url = new URL(`${geocoder.baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  if (geocoder.apiKey && geocoder.authQueryParam) url.searchParams.set(geocoder.authQueryParam, geocoder.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'SynapseDX/0.3',
        ...(geocoder.apiKey && !geocoder.authQueryParam ? { [geocoder.authHeader]: geocoder.apiKey } : {}),
      },
      signal: controller.signal,
    });
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw apiError(429, 'rate_limited', 'the geocoder provider rate limit was exceeded', {
        ...GEO_DEPENDENCY, provider: geocoder.provider, retryAfter: retryAfter || undefined,
      });
    }
    if (!response.ok) {
      throw apiError(503, 'geocoder_unavailable', 'the geocoder provider rejected the request', {
        ...GEO_DEPENDENCY, provider: geocoder.provider, providerStatus: response.status,
      });
    }
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw apiError(503, 'geocoder_unavailable', 'the geocoder provider returned a non-JSON response', {
        ...GEO_DEPENDENCY, provider: geocoder.provider,
      });
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw apiError(503, 'geocoder_unavailable', 'the geocoder provider is unreachable', {
      ...GEO_DEPENDENCY, provider: geocoder.provider,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function registerGeoRoutes(app: Express, config: ServiceConfig): void {
  app.get('/v1/capabilities/geo/autocomplete', handler(async (req, res) => {
    await authenticate(req, config, true);
    const q = stringParam(req.query.q, 200);
    if (!q) throw apiError(400, 'field_required', 'q is required', { field: 'q' });
    const result = await providerCall(config, config.geocoder?.endpoints.autocomplete || '/autocomplete', {
      q, text: q, limit: stringParam(req.query.limit, 4), focus: stringParam(req.query.focus, 64),
      display_type: '5',
    });
    res.setHeader('cache-control', 'private, max-age=30');
    res.json({ provider: config.geocoder?.provider, items: normalizeGeoResults(result) });
  }));

  app.get('/v1/capabilities/geo/geocode', handler(async (req, res) => {
    await authenticate(req, config, true);
    const address = stringParam(req.query.address, 300);
    if (!address) throw apiError(400, 'field_required', 'address is required', { field: 'address' });
    const result = await providerCall(config, config.geocoder?.endpoints.geocode || '/geocode', {
      address, text: address, display_type: '5',
    });
    res.setHeader('cache-control', 'private, max-age=30');
    res.json({ provider: config.geocoder?.provider, items: normalizeGeoResults(result) });
  }));

  app.get('/v1/capabilities/geo/reverse', handler(async (req, res) => {
    await authenticate(req, config, true);
    const lat = stringParam(req.query.lat, 32);
    const lon = stringParam(req.query.lon, 32);
    if (!lat || !lon) throw apiError(400, 'field_required', 'lat and lon are required');
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
      throw apiError(400, 'invalid_request', 'lat and lon must be numeric');
    }
    const result = await providerCall(config, config.geocoder?.endpoints.reverse || '/reverse', {
      lat, lon, lng: lon, display_type: '5',
    });
    res.setHeader('cache-control', 'private, max-age=30');
    res.json({ provider: config.geocoder?.provider, items: normalizeGeoResults(result) });
  }));

  app.get('/v1/capabilities/geo/place', handler(async (req, res) => {
    await authenticate(req, config, true);
    const id = stringParam(req.query.id, 200);
    if (!id) throw apiError(400, 'field_required', 'id is required', { field: 'id' });
    const result = await providerCall(config, config.geocoder?.endpoints.place || '/place', { id, refid: id });
    const items = normalizeGeoResults(result);
    res.setHeader('cache-control', 'private, max-age=30');
    res.json({ provider: config.geocoder?.provider, result: items[0] || null });
  }));
}
