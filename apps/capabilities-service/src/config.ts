// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Runtime configuration for the Tier-2 capabilities service.
 *
 * Configuration is read from the environment on every call so tests can point
 * the service at a local fake Tier-1 without re-importing the module. Production
 * configuration must use public HTTPS endpoints; localhost and private service
 * addresses are rejected unless `ALLOW_LOCAL_DEPENDENCIES=true` (tests only).
 */

export const DEFAULT_CORS_ORIGINS = [
  'https://synapsecity.sbs',
  'https://sos.synapsecity.sbs',
  'https://synapsedx.sbs',
  'https://cloud.synapsedx.sbs',
];

export type AuthMode = 'required' | 'optional';

export interface GeocoderConfig {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  /** Header that carries the provider key (generic provider). */
  authHeader: string;
  /** Query parameter that carries the provider key (e.g. VietMap `apikey`). */
  authQueryParam?: string;
  /** Endpoint paths; presets fill these for known providers. */
  endpoints: { autocomplete: string; geocode: string; reverse: string; place: string };
  /** Optional raster tile path with `{style}`, `{z}`, `{x}` and `{y}` placeholders. */
  tilesPath?: string;
  /** Optional tile origin when it differs from the geocoder base (VietMap). */
  tilesBaseUrl?: string;
  /** Tile provider credential when tiles use a different key than geocoding. */
  tilesApiKey?: string;
  /** Tile credential transport (VietMap uses `apikey`). */
  tilesAuthQueryParam?: string;
  tilesAuthHeader?: string;
  /** Tile style allowlist (VietMap: tm|lm|dm|hm|st). */
  tileStyle?: string;
}

export interface TurnstileConfig {
  secret: string;
  verifyUrl: string;
}

export interface ServiceConfig {
  port: number;
  tier1BaseUrl: string;
  eventsQueue: string;
  eventsStream: string;
  corsOrigins: string[];
  authMode: AuthMode;
  allowLocalDependencies: boolean;
  allowAnonymousPublicReads: boolean;
  serviceToken?: string;
  serviceApiKey?: string;
  serviceTenant?: string;
  hasServiceCredential: boolean;
  idempotencyTtlSeconds: number;
  idempotencyEnabled: boolean;
  maxPageSize: number;
  requestTimeoutMs: number;
  /** Public Tier-2 origin used when Tier-1 schedules call back into Tier 2. */
  publicUrl: string;
  geocoder?: GeocoderConfig;
  /** Faststore TTL for normalized geocoder responses. */
  geoCacheTtlSeconds: number;
  /** Upper bound for a cached provider tile; larger tiles are streamed uncached. */
  geoTileCacheMaxBytes: number;
  /** Verify CAPTCHA tokens through the shared Tier-2 provider adapter. */
  turnstile?: TurnstileConfig;
  /** Provision the KTTV crawler as a Tier-1 SynapseFlow workflow on startup. */
  kttvScheduleEnabled: boolean;
  kttvScheduleEverySeconds: number;
  auditEnabled: boolean;
  /** Bind every Tier-2 password/OIDC flow to one Tier-1 organization. */
  authOrgSlug?: string;
  /** Default delegated-token audience for `/v1/capabilities/auth/exchange`. */
  authAudience: string;
  /** Audiences a caller may request from the exchange endpoint. */
  authAllowedAudiences: string[];
  filesMaxBytes: number;
  filesQuotaBytes: number;
  filesAllowedTypes: string[];
  filesPresignTtlSeconds: number;
  filesPrefix: string;
  /** SynapseOCS bucket for Tier-2 file bytes (never the process filesystem). */
  filesBucket: string;
  /** OCR engine for file-backed OCR jobs: `tesseract` (local CLI) or `off`. */
  ocrEngine: 'tesseract' | 'off';
  /** Tesseract language packs, joined with `+` (for example `vie+eng`). */
  ocrLanguages: string;
  tesseractBin: string;
  ocrTimeoutMs: number;
  ocrMaxBytes: number;
  /** Requests allowed to wait for the single OCR worker before 429. */
  ocrMaxQueue: number;
  /** Let RAG write the answer with the Tier-1 LLM (extractive fallback). */
  ragGenerate: boolean;
  /** Use Tier-1 embeddings for RAG when the model is real (not mock). */
  ragTier1Embeddings: boolean;
  ragLlmTimeoutMs: number;
}

function boolValue(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function intValue(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

/** Hostnames that never belong in a production dependency URL. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === 'host.docker.internal' || host === 'gateway.docker.internal') return true;
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** Validate and normalize a dependency URL, failing fast on a non-public host. */
export function assertPublicDependency(raw: string, name: string, allowLocal: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not an absolute URL: ${raw}`);
  }
  const local = isPrivateHost(url.hostname);
  if (local && !allowLocal) {
    throw new Error(`${name} must be a public HTTPS endpoint (set ALLOW_LOCAL_DEPENDENCIES=true only for tests)`);
  }
  if (url.protocol !== 'https:' && !local) throw new Error(`${name} must use HTTPS`);
  return raw.replace(/\/+$/, '');
}

function parseOrigins(env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const raw of [env.CORS_ORIGINS, env.CORS_ORIGIN]) {
    if (!raw) continue;
    for (const origin of raw.split(',')) {
      const trimmed = origin.trim().replace(/\/+$/, '');
      if (trimmed && !values.includes(trimmed)) values.push(trimmed);
    }
  }
  return values.length ? values : [...DEFAULT_CORS_ORIGINS];
}

const VIETMAP_ENDPOINTS = {
  autocomplete: '/autocomplete/v4',
  geocode: '/search/v4',
  reverse: '/reverse/v4',
  place: '/place/v4',
};

const GENERIC_ENDPOINTS = {
  autocomplete: '/autocomplete',
  geocode: '/geocode',
  reverse: '/reverse',
  place: '/place',
};

const TILE_STYLES = new Set(['tm', 'lm', 'dm', 'hm', 'st']);

function parseTileStyle(raw: string | undefined): string {
  const value = String(raw || 'tm').trim().toLowerCase();
  return TILE_STYLES.has(value) ? value : 'tm';
}

function parseGeocoder(env: NodeJS.ProcessEnv, allowLocal: boolean): GeocoderConfig | undefined {
  const provider = env.SYNAPSEDX_GEOCODER_PROVIDER?.trim().toLowerCase() || '';
  const rawBase = env.SYNAPSEDX_GEOCODER_BASE_URL?.trim()
    || (provider === 'vietmap' ? 'https://maps.vietmap.vn/api' : '');
  if (!rawBase) return undefined;
  const apiKey = env.SYNAPSEDX_GEOCODER_API_KEY?.trim() || undefined;
  const isVietMap = provider === 'vietmap';
  const tilesPath = env.SYNAPSEDX_GEOCODER_TILES_PATH?.trim()
    || (isVietMap ? '/maps/tiles/{style}/{z}/{x}/{y}.png' : '');
  const tilesBaseUrl = env.SYNAPSEDX_GEOCODER_TILES_BASE_URL?.trim()
    || (isVietMap ? 'https://maps.vietmap.vn' : '');
  const tilesApiKey = env.SYNAPSEDX_GEOCODER_TILES_API_KEY?.trim() || (isVietMap ? apiKey : '');
  const tilesAuthQueryParam = env.SYNAPSEDX_GEOCODER_TILES_AUTH_QUERY?.trim()
    || (tilesBaseUrl.includes('vietmap.vn') ? 'apikey' : '');
  const tilesAuthHeader = env.SYNAPSEDX_GEOCODER_TILES_AUTH_HEADER?.trim() || env.SYNAPSEDX_GEOCODER_AUTH_HEADER?.trim() || 'x-api-key';
  return {
    provider: provider || 'generic',
    baseUrl: assertPublicDependency(rawBase, 'SYNAPSEDX_GEOCODER_BASE_URL', allowLocal),
    ...(apiKey ? { apiKey } : {}),
    authHeader: env.SYNAPSEDX_GEOCODER_AUTH_HEADER?.trim() || 'x-api-key',
    ...(isVietMap ? { authQueryParam: env.SYNAPSEDX_GEOCODER_AUTH_QUERY?.trim() || 'apikey' } : {}),
    endpoints: {
      autocomplete: env.SYNAPSEDX_GEOCODER_AUTOCOMPLETE_PATH?.trim() || (isVietMap ? VIETMAP_ENDPOINTS.autocomplete : GENERIC_ENDPOINTS.autocomplete),
      geocode: env.SYNAPSEDX_GEOCODER_GEOCODE_PATH?.trim() || (isVietMap ? VIETMAP_ENDPOINTS.geocode : GENERIC_ENDPOINTS.geocode),
      reverse: env.SYNAPSEDX_GEOCODER_REVERSE_PATH?.trim() || (isVietMap ? VIETMAP_ENDPOINTS.reverse : GENERIC_ENDPOINTS.reverse),
      place: env.SYNAPSEDX_GEOCODER_PLACE_PATH?.trim() || (isVietMap ? VIETMAP_ENDPOINTS.place : GENERIC_ENDPOINTS.place),
    },
    ...(tilesPath ? { tilesPath, tileStyle: parseTileStyle(env.SYNAPSEDX_GEOCODER_TILE_STYLE) } : {}),
    ...(tilesPath && tilesBaseUrl
      ? {
          tilesBaseUrl: assertPublicDependency(tilesBaseUrl, 'SYNAPSEDX_GEOCODER_TILES_BASE_URL', allowLocal),
          ...(tilesApiKey ? { tilesApiKey } : {}),
          ...(tilesAuthQueryParam ? { tilesAuthQueryParam } : {}),
          tilesAuthHeader,
        }
      : {}),
  };
}

function listValue(raw: string | undefined, fallback: string[]): string[] {
  const values = String(raw || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return values.length ? [...new Set(values)] : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const allowLocal = boolValue(env.ALLOW_LOCAL_DEPENDENCIES);
  const tier1BaseUrl = assertPublicDependency(
    env.SYNAPSEONE_BASE_URL || 'https://api.synapseone.space',
    'SYNAPSEONE_BASE_URL',
    allowLocal,
  );
  const rawAuthMode = (env.SYNAPSEDX_AUTH_MODE || 'required').trim().toLowerCase();
  if (rawAuthMode !== 'required' && rawAuthMode !== 'optional') {
    throw new Error('SYNAPSEDX_AUTH_MODE must be "required" or "optional"');
  }
  const authMode = rawAuthMode as AuthMode;
  if (authMode === 'optional' && !allowLocal) {
    throw new Error('SYNAPSEDX_AUTH_MODE=optional is only allowed with ALLOW_LOCAL_DEPENDENCIES=true');
  }
  if (authMode === 'optional' && env.NODE_ENV === 'production') {
    throw new Error('SYNAPSEDX_AUTH_MODE=optional is forbidden in production');
  }
  const serviceToken = env.SYNAPSEONE_TOKEN?.trim() || undefined;
  const serviceApiKey = env.SYNAPSEONE_API_KEY?.trim() || undefined;
  const geocoder = parseGeocoder(env, allowLocal);
  const publicUrl = assertPublicDependency(
    env.SYNAPSEDX_PUBLIC_URL || 'https://synapsedx.sbs',
    'SYNAPSEDX_PUBLIC_URL',
    allowLocal,
  );
  const turnstileSecret = env.SYNAPSEDX_TURNSTILE_SECRET_KEY?.trim() || '';
  const turnstile = turnstileSecret
    ? {
        secret: turnstileSecret,
        verifyUrl: assertPublicDependency(
          env.SYNAPSEDX_TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
          'SYNAPSEDX_TURNSTILE_VERIFY_URL',
          allowLocal,
        ),
      }
    : undefined;
  const authAudience = env.SYNAPSEDX_AUTH_AUDIENCE?.trim() || 'synapsedx';
  const authAllowedAudiences = listValue(
    env.SYNAPSEDX_AUTH_ALLOWED_AUDIENCES,
    [authAudience, 'synapsecity', 'synapsecitysos'],
  );
  if (!authAllowedAudiences.includes(authAudience)) authAllowedAudiences.unshift(authAudience);
  const filesPrefix = (env.SYNAPSEDX_FILES_PREFIX?.trim() || 'synapsedx/files').replace(/^\/+|\/+$/g, '');
  const filesBucket = (env.SYNAPSEDX_FILES_BUCKET?.trim() || 'synapsedx-files');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(filesBucket)) {
    throw new Error('SYNAPSEDX_FILES_BUCKET must be a valid SynapseOCS bucket name (3..63 lowercase characters)');
  }
  if (!/^[A-Za-z0-9._@:/-]{1,200}$/.test(filesPrefix)) {
    throw new Error('SYNAPSEDX_FILES_PREFIX must match [A-Za-z0-9._@:/-]{1,200}');
  }
  return {
    port: intValue(env.PORT, 8082, 1, 65535),
    tier1BaseUrl,
    eventsQueue: env.SYNAPSEDX_EVENTS_QUEUE?.trim() || 'synapsedx-capability-events',
    eventsStream: env.SYNAPSEDX_EVENTS_STREAM?.trim() || 'synapsedx-capability-events',
    corsOrigins: parseOrigins(env),
    authMode,
    allowLocalDependencies: allowLocal,
    allowAnonymousPublicReads: true,
    serviceToken,
    serviceApiKey,
    serviceTenant: env.SYNAPSEONE_TENANT?.trim() || undefined,
    hasServiceCredential: Boolean(serviceToken || serviceApiKey),
    idempotencyTtlSeconds: intValue(env.SYNAPSEDX_IDEMPOTENCY_TTL_SECONDS, 86400, 60, 604800),
    idempotencyEnabled: boolValue(env.SYNAPSEDX_IDEMPOTENCY_ENABLED, true),
    maxPageSize: intValue(env.SYNAPSEDX_MAX_PAGE_SIZE, 500, 1, 1000),
    requestTimeoutMs: intValue(env.SYNAPSEDX_REQUEST_TIMEOUT_MS, 20000, 1000, 120000),
    publicUrl,
    ...(geocoder ? { geocoder } : {}),
    geoCacheTtlSeconds: intValue(env.SYNAPSEDX_GEO_CACHE_TTL_SECONDS, 300, 0, 86400),
    geoTileCacheMaxBytes: intValue(env.SYNAPSEDX_GEO_TILE_CACHE_MAX_BYTES, 512 * 1024, 0, 2 * 1024 * 1024),
    ...(turnstile ? { turnstile } : {}),
    kttvScheduleEnabled: boolValue(env.SYNAPSEDX_KTTV_SCHEDULE_ENABLED, true),
    kttvScheduleEverySeconds: intValue(env.SYNAPSEDX_KTTV_SCHEDULE_EVERY_SECONDS, 1800, 60, 86400),
    auditEnabled: boolValue(env.SYNAPSEDX_AUDIT_ENABLED, true),
    ...(env.SYNAPSEDX_AUTH_ORG_SLUG?.trim() ? { authOrgSlug: env.SYNAPSEDX_AUTH_ORG_SLUG.trim() } : {}),
    authAudience,
    authAllowedAudiences,
    filesMaxBytes: intValue(env.SYNAPSEDX_FILES_MAX_BYTES, 25 * 1024 * 1024, 1024, 5 * 1024 * 1024 * 1024),
    filesQuotaBytes: intValue(env.SYNAPSEDX_FILES_QUOTA_BYTES, 1024 * 1024 * 1024, 1024, 1024 ** 4),
    filesAllowedTypes: listValue(env.SYNAPSEDX_FILES_ALLOWED_TYPES, []),
    filesPresignTtlSeconds: intValue(env.SYNAPSEDX_FILES_PRESIGN_TTL_SECONDS, 900, 1, 604800),
    filesPrefix,
    filesBucket,
    ocrEngine: ocrEngineValue(env.SYNAPSEDX_OCR_ENGINE),
    ocrLanguages: ocrLanguagesValue(env.SYNAPSEDX_OCR_LANGUAGES),
    tesseractBin: env.SYNAPSEDX_TESSERACT_BIN?.trim() || 'tesseract',
    ocrTimeoutMs: intValue(env.SYNAPSEDX_OCR_TIMEOUT_MS, 60000, 1000, 600000),
    ocrMaxBytes: intValue(env.SYNAPSEDX_OCR_MAX_BYTES, 10 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    ocrMaxQueue: intValue(env.SYNAPSEDX_OCR_MAX_QUEUE, 4, 0, 100),
    ragGenerate: boolValue(env.SYNAPSEDX_RAG_GENERATE, true),
    ragTier1Embeddings: boolValue(env.SYNAPSEDX_RAG_TIER1_EMBEDDINGS, true),
    ragLlmTimeoutMs: intValue(env.SYNAPSEDX_RAG_LLM_TIMEOUT_MS, 45000, 1000, 300000),
  };
}

function ocrEngineValue(raw: string | undefined): 'tesseract' | 'off' {
  const value = String(raw || 'tesseract').trim().toLowerCase();
  if (value !== 'tesseract' && value !== 'off') throw new Error('SYNAPSEDX_OCR_ENGINE must be "tesseract" or "off"');
  return value;
}

function ocrLanguagesValue(raw: string | undefined): string {
  const value = String(raw || 'vie+eng').trim();
  if (!/^[A-Za-z_]{3,16}(\+[A-Za-z_]{3,16}){0,5}$/.test(value)) {
    throw new Error('SYNAPSEDX_OCR_LANGUAGES must look like "vie+eng"');
  }
  return value;
}
