// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Provider-neutral search/geocoding/map capability.
 *
 * The operator configures one licensed provider (VietMap preset or any
 * compatible REST adapter) and the credential stays server-side. City and SOS
 * call the same normalized contract, so neither product needs a provider key,
 * a duplicate integration or a direct vendor call.
 *
 * Normalized geocoder responses are cached in Synapse Faststore (Tier 1) so
 * repeated searches do not hit the provider. Raster tiles use the same
 * provider credential through Tier 2 and are cached as short-lived base64
 * values when they fit the configured cache bound.
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
import { createHash } from 'node:crypto';
import { SynapseOneClient } from '@synapseone/sdk';
import { authenticate } from '../auth';
import { ServiceConfig } from '../config';
import { ApiError, apiError } from '../errors';
import { handler } from '../http';
import { stringParam } from '../pagination';
import { serviceClient } from '../platform';

const GEO_DEPENDENCY = {
  dependency: 'tier2-geocoder',
  operation: 'configure SYNAPSEDX_GEOCODER_PROVIDER/BASE_URL/API_KEY with a licensed provider',
  tracking: 'https://github.com/vku-open-source-2026/SynapseDX/issues/17',
};

const MAX_TILE_ZOOM = 22;
const MAX_TILE_BYTES = 5 * 1024 * 1024;

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
    const address = entry?.address ?? entry?.display_name ?? entry?.display_address
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

interface FaststoreEnvelope<T> {
  value?: T;
  type?: string;
}

function unwrapFaststore<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object' && raw !== null && 'value' in (raw as Record<string, unknown>) && 'type' in (raw as Record<string, unknown>)) {
    return ((raw as FaststoreEnvelope<T>).value ?? null) as T | null;
  }
  return raw as T;
}

function cacheKeyFor(provider: string, kind: string, payload: string): string {
  const digest = createHash('sha256').update(payload).digest('hex');
  return `synapsedx:geo:${provider.replace(/[^A-Za-z0-9_.-]/g, '_')}:${kind}:${digest}`;
}

async function cacheGet<T>(client: SynapseOneClient, key: string): Promise<T | null> {
  try {
    return unwrapFaststore<T>(await client.faststore.get(key));
  } catch {
    return null;
  }
}

async function cacheSet(client: SynapseOneClient, key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return;
  try {
    await client.faststore.set(key, value, { ttlSeconds });
  } catch {
    // Cache is best-effort; the provider response is still authoritative.
  }
}

function providerUrl(config: ServiceConfig, path: string, query: Record<string, string | undefined>, baseUrl?: string): URL {
  const geocoder = config.geocoder;
  if (!geocoder) {
    throw apiError(503, 'geocoder_unavailable', 'no geocoder provider is configured for this deployment', GEO_DEPENDENCY);
  }
  const url = new URL(`${baseUrl || geocoder.baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  if (geocoder.apiKey && geocoder.authQueryParam) url.searchParams.set(geocoder.authQueryParam, geocoder.apiKey);
  return url;
}

async function providerCall(
  config: ServiceConfig,
  client: SynapseOneClient,
  path: string,
  query: Record<string, string | undefined>,
): Promise<unknown> {
  const geocoder = config.geocoder;
  if (!geocoder) {
    throw apiError(503, 'geocoder_unavailable', 'no geocoder provider is configured for this deployment', GEO_DEPENDENCY);
  }
  const url = providerUrl(config, path, query);
  const cacheKey = cacheKeyFor(geocoder.provider, 'json', url.toString());
  const cached = await cacheGet<unknown>(client, cacheKey);
  if (cached !== null) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'SynapseDX/0.3 (+https://synapsedx.sbs)',
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
      const parsed = text ? JSON.parse(text) : null;
      await cacheSet(client, cacheKey, parsed, config.geoCacheTtlSeconds);
      return parsed;
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

function tilePath(config: ServiceConfig, z: number, x: number, y: number): string {
  const geocoder = config.geocoder;
  if (!geocoder?.tilesPath) {
    throw apiError(503, 'map_tiles_unavailable', 'no raster tile provider is configured for this deployment', GEO_DEPENDENCY);
  }
  return geocoder.tilesPath
    .replaceAll('{style}', encodeURIComponent(geocoder.tileStyle || 'tm'))
    .replaceAll('{z}', String(z))
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y));
}

function parseTileCoordinate(raw: string, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw apiError(400, 'invalid_request', 'tile coordinates must be non-negative integers within range');
  }
  return value;
}

export function registerGeoRoutes(app: Express, config: ServiceConfig): void {
  const client = serviceClient(config);

  app.get('/v1/capabilities/geo/status', handler(async (req, res) => {
    await authenticate(req, config, true);
    res.setHeader('cache-control', 'private, max-age=60');
    res.json({
      provider: config.geocoder?.provider || null,
      configured: Boolean(config.geocoder),
      tiles: {
        configured: Boolean(config.geocoder?.tilesPath),
        ...(config.geocoder?.tilesPath ? { path: '/v1/capabilities/geo/tiles/{z}/{x}/{y}.png', style: config.geocoder.tileStyle || 'tm' } : {}),
      },
      cache: { ttlSeconds: config.geoCacheTtlSeconds, store: 'synapse-faststore' },
    });
  }));

  app.get('/v1/capabilities/geo/autocomplete', handler(async (req, res) => {
    await authenticate(req, config, true);
    const q = stringParam(req.query.q, 200);
    if (!q) throw apiError(400, 'field_required', 'q is required', { field: 'q' });
    const result = await providerCall(config, client, config.geocoder?.endpoints.autocomplete || '/autocomplete', {
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
    const result = await providerCall(config, client, config.geocoder?.endpoints.geocode || '/geocode', {
      q: address, address, text: address, limit: stringParam(req.query.limit, 5), display_type: '5',
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
    const result = await providerCall(config, client, config.geocoder?.endpoints.reverse || '/reverse', {
      lat, lon, lng: lon, display_type: '5',
    });
    res.setHeader('cache-control', 'private, max-age=30');
    res.json({ provider: config.geocoder?.provider, items: normalizeGeoResults(result) });
  }));

  app.get('/v1/capabilities/geo/place', handler(async (req, res) => {
    await authenticate(req, config, true);
    const id = stringParam(req.query.id, 200);
    if (!id) throw apiError(400, 'field_required', 'id is required', { field: 'id' });
    const result = await providerCall(config, client, config.geocoder?.endpoints.place || '/place', { id, refid: id });
    const items = normalizeGeoResults(result);
    res.setHeader('cache-control', 'private, max-age=30');
    res.json({ provider: config.geocoder?.provider, result: items[0] || null });
  }));

  app.get('/v1/capabilities/geo/tiles/:z/:x/:y.png', handler(async (req, res) => {
    await authenticate(req, config, true);
    const geocoder = config.geocoder;
    if (!geocoder?.tilesPath) {
      throw apiError(503, 'map_tiles_unavailable', 'no raster tile provider is configured for this deployment', GEO_DEPENDENCY);
    }
    const z = parseTileCoordinate(String(req.params.z), MAX_TILE_ZOOM);
    const max = 2 ** z - 1;
    const x = parseTileCoordinate(String(req.params.x), max);
    const y = parseTileCoordinate(String(req.params.y), max);
    const path = tilePath(config, z, x, y);
    const url = new URL(`${geocoder.tilesBaseUrl || geocoder.baseUrl}${path}`);
    if (geocoder.tilesApiKey && geocoder.tilesAuthQueryParam) url.searchParams.set(geocoder.tilesAuthQueryParam, geocoder.tilesApiKey);
    const cacheKey = cacheKeyFor(geocoder.provider, 'tile', `${geocoder.tileStyle || 'tm'}|${z}|${x}|${y}`);
    const cached = await cacheGet<{ contentType?: string; base64?: string }>(client, cacheKey);
    if (cached?.base64) {
      res.setHeader('content-type', cached.contentType || 'image/png');
      res.setHeader('cache-control', 'public, max-age=86400, immutable');
      res.setHeader('x-tier2-cache', 'hit');
      res.send(Buffer.from(cached.base64, 'base64'));
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'image/png,image/*;q=0.8',
          'user-agent': 'SynapseDX/0.3 (+https://synapsedx.sbs)',
          ...(geocoder.tilesApiKey && !geocoder.tilesAuthQueryParam ? { [geocoder.tilesAuthHeader || 'x-api-key']: geocoder.tilesApiKey } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw apiError(503, 'map_tiles_unavailable', 'the tile provider rejected the request', {
          ...GEO_DEPENDENCY, provider: geocoder.provider, providerStatus: response.status,
        });
      }
      const contentType = String(response.headers.get('content-type') || 'image/png');
      if (!contentType.startsWith('image/')) {
        throw apiError(503, 'map_tiles_unavailable', 'the tile provider returned a non-image response', {
          ...GEO_DEPENDENCY, provider: geocoder.provider,
        });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_TILE_BYTES) {
        throw apiError(503, 'map_tiles_unavailable', 'the tile provider returned an oversized tile', {
          ...GEO_DEPENDENCY, provider: geocoder.provider,
        });
      }
      if (config.geoTileCacheMaxBytes > 0 && buffer.byteLength <= config.geoTileCacheMaxBytes) {
        await cacheSet(client, cacheKey, { contentType, base64: buffer.toString('base64') }, 86400);
      }
      res.setHeader('content-type', contentType);
      res.setHeader('cache-control', 'public, max-age=86400, immutable');
      res.setHeader('x-tier2-cache', 'miss');
      res.send(buffer);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw apiError(503, 'map_tiles_unavailable', 'the tile provider is unreachable', {
        ...GEO_DEPENDENCY, provider: geocoder.provider,
      });
    } finally {
      clearTimeout(timer);
    }
  }));
}
