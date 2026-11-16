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

/**
 * Hostnames that never belong in a production dependency URL.
 *
 * Everything that a container runtime, an internal DNS zone or a link-local
 * network can resolve must be rejected: a Tier-2 dependency has to be a public
 * HTTPS endpoint, never a Docker service name, a private DNS suffix or an
 * RFC 1918 / CGNAT / IPv6 ULA address. A false positive only makes the
 * deployment fail fast at start-up; a false negative would route Tier-2 traffic
 * to a private service and break the tier contract, so the check is strict.
 */
const PRIVATE_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.corp',
  '.lan',
  '.home.arpa',
  '.svc',
  '.consul',
  '.cluster.local',
  '.docker.internal',
];

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const [a, b, c] = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });
  if (![a, b, c].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    // Not a valid dotted quad; treat it as a name and let the caller decide.
    return false;
  }
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24, 192.0.2.0/24 documentation
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Expand an IPv6 literal to eight 16-bit groups (null when invalid). */
function ipv6Groups(input: string): number[] | null {
  const value = input.split('%')[0];
  if (!value.includes(':')) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    const items = part.split(':');
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.includes('.')) {
        // Embedded IPv4 is only legal in the last group.
        if (index !== items.length - 1) return null;
        const v4 = item.split('.').map(Number);
        if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
      out.push(parseInt(item, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...new Array<number>(fill).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

function ipv4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function isPrivateIpv6(groups: number[]): boolean {
  const firstFiveZero = groups.slice(0, 5).every((group) => group === 0);
  if (groups.every((group) => group === 0)) return true; // ::
  if (firstFiveZero && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return true; // ::1
  if (groups.slice(0, 6).every((group) => group === 0) && (groups[6] !== 0 || groups[7] !== 0)) {
    // Deprecated IPv4-compatible ::a.b.c.d
    return true;
  }
  if (firstFiveZero && groups[5] === 0xffff) {
    return isPrivateIpv4(ipv4FromGroups(groups[6], groups[7])); // ::ffff:a.b.c.d
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return isPrivateIpv4(ipv4FromGroups(groups[6], groups[7])); // NAT64 64:ff9b::/96
  }
  if (groups[0] === 0x100 && groups.slice(1, 4).every((group) => group === 0)) {
    return true; // 100::/64 discard-only
  }
  if (groups[0] === 0x2001 && groups[1] === 0xdb8) return true; // documentation 2001:db8::/32
  if (groups[0] === 0x2002) {
    return isPrivateIpv4(ipv4FromGroups(groups[1], groups[2])); // 6to4 embeds IPv4
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  for (const suffix of PRIVATE_SUFFIXES) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIpv4(host);
  if (host.includes(':')) {
    const groups = ipv6Groups(host);
    if (!groups) return true; // malformed IPv6 literal: never a public dependency
    return isPrivateIpv6(groups);
  }
  // A hostname without a dot is a Docker/Kubernetes/compose service name; it can
  // resolve only inside the private network (e.g. `capabilities`, `postgres`).
  return !host.includes('.');
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
