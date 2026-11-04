// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Dataset metadata validation: license (against the Tier-1 LDS catalog),
 * schema version and entity type.
 */
import { SynapseOneClient } from '@synapseone/sdk';
import { ServiceConfig } from './config';
import { apiError } from './errors';
import { SEMVER_RE } from './ids';

export interface LicenseEntry {
  id: string;
  name?: string;
  url?: string;
  openData: boolean;
}

/**
 * Static fallback mirroring the built-in SynapseLDS catalog. It is only used
 * when the Tier-1 license endpoint is temporarily unreachable so that reads
 * and other writes stay available; a warning is logged.
 */
const BUILTIN_LICENSES: LicenseEntry[] = [
  { id: 'CC0-1.0', openData: true },
  { id: 'PDDL-1.0', openData: true },
  { id: 'CC-BY-4.0', openData: true },
  { id: 'CC-BY-SA-4.0', openData: true },
  { id: 'ODbL-1.0', openData: true },
  { id: 'LicenseRef-Proprietary', openData: false },
];

const CUSTOM_LICENSE_RE = /^LicenseRef-[A-Za-z0-9._-]{1,128}$/;

let cache: { key: string; at: number; entries: LicenseEntry[] } | undefined;
const CACHE_TTL_MS = 60_000;

export function resetLicenseCache(): void {
  cache = undefined;
}

export async function licenseCatalog(client: SynapseOneClient, config: ServiceConfig): Promise<LicenseEntry[]> {
  const key = config.tier1BaseUrl;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.entries;
  try {
    const raw = await client.lds.licenses();
    const entries = (Array.isArray(raw) ? raw : [])
      .map((item: any) => ({
        id: String(item?.id || ''),
        name: item?.name ? String(item.name) : undefined,
        url: item?.url ? String(item.url) : undefined,
        openData: item?.openData === true,
      }))
      .filter((item) => item.id);
    if (entries.length) {
      cache = { key, at: Date.now(), entries };
      return entries;
    }
  } catch (error) {
    console.warn(`[synapsedx] license catalog unavailable, using the built-in allow-list: ${(error as Error).message}`);
  }
  return [...BUILTIN_LICENSES];
}

export function isOpenDataLicense(entries: LicenseEntry[], license: string): boolean {
  const found = entries.find((entry) => entry.id === license);
  return found ? found.openData : false;
}

function httpsUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw apiError(400, 'invalid_request', `${field} must be an absolute URL`);
  }
  if (url.protocol !== 'https:') throw apiError(400, 'invalid_request', `${field} must use HTTPS`);
  return value;
}

export async function validateLicense(
  client: SynapseOneClient,
  config: ServiceConfig,
  license: string,
  options: { public?: boolean; licenseUrl?: string } = {},
): Promise<{ license: string; licenseUrl?: string; openData: boolean }> {
  const value = String(license || '').trim();
  if (!value) throw apiError(400, 'field_required', 'license is required', { field: 'license' });
  const entries = await licenseCatalog(client, config);
  const custom = CUSTOM_LICENSE_RE.test(value);
  const known = entries.some((entry) => entry.id === value);
  if (!known && !custom) {
    throw apiError(400, 'invalid_license', 'license is not in the SynapseLDS license catalog', {
      license: value,
      allowed: entries.map((entry) => entry.id),
    });
  }
  const openData = isOpenDataLicense(entries, value);
  if (options.public === true && !openData) {
    throw apiError(400, 'invalid_license', 'a public dataset requires an open-data license', {
      license: value,
      openData,
    });
  }
  const catalogUrl = entries.find((entry) => entry.id === value)?.url;
  const licenseUrl = options.licenseUrl
    ? httpsUrl(String(options.licenseUrl), 'licenseUrl')
    : catalogUrl;
  return { license: value, ...(licenseUrl ? { licenseUrl } : {}), openData };
}

export function validateSchemaVersion(value: unknown): string {
  const version = String(value ?? '').trim();
  if (!SEMVER_RE.test(version)) {
    throw apiError(400, 'invalid_schema_version', 'schemaVersion must be a semantic version (e.g. 1.0.0)');
  }
  return version;
}

export function validateEntityType(value: unknown): string {
  const entityType = String(value ?? '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(entityType)) {
    throw apiError(400, 'invalid_request', 'entityType must match [A-Za-z][A-Za-z0-9_-]{0,63}', { field: 'entityType' });
  }
  return entityType;
}

export function validateRetentionDays(value: unknown): number {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw apiError(400, 'invalid_retention', 'retentionDays must be an integer 1..3650');
  }
  return days;
}
