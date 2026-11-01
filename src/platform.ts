import { Request } from 'express';
import { SynapseOneClient, SynapseOneError } from '@synapseone/sdk';

export const COLLECTIONS = {
  datasets: 'synapsedx_capability_datasets',
  records: 'synapsedx_capability_records',
} as const;

export interface DatasetRecord {
  id: string;
  slug: string;
  name: string;
  entityType: string;
  license: string;
  description?: string;
  public: boolean;
  owner?: string;
  schemaVersion: string;
  status: 'draft' | 'published' | 'revoked';
  ldsDatasourceId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityRecord {
  id: string;
  datasetId: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const configuredTier1Url = process.env.SYNAPSEONE_BASE_URL || 'https://api.synapseone.space';

function assertPublicDependency(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`SYNAPSEONE_BASE_URL is not an absolute URL: ${raw}`); }
  const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(url.hostname);
  if (local && process.env.ALLOW_LOCAL_DEPENDENCIES !== 'true') {
    throw new Error('SYNAPSEONE_BASE_URL must be a public HTTPS endpoint');
  }
  if (url.protocol !== 'https:' && !local) throw new Error('SYNAPSEONE_BASE_URL must use HTTPS');
  return raw.replace(/\/$/, '');
}

export const TIER1_URL = assertPublicDependency(configuredTier1Url);
export const EVENTS_QUEUE = process.env.SYNAPSEDX_EVENTS_QUEUE || 'synapsedx-capability-events';

export function tier1FromRequest(req: Request): SynapseOneClient {
  const authorization = req.header('authorization');
  const token = authorization?.replace(/^Bearer\s+/i, '').trim() || process.env.SYNAPSEONE_TOKEN;
  const apiKey = req.header('x-api-key') || process.env.SYNAPSEONE_API_KEY;
  return new SynapseOneClient({
    baseUrl: TIER1_URL,
    token: token || undefined,
    apiKey: apiKey || undefined,
    tenant: req.header('x-synapseone-tenant') || process.env.SYNAPSEONE_TENANT || undefined,
  });
}

export function isNotFound(error: unknown): boolean {
  return error instanceof SynapseOneError && error.status === 404;
}

export async function ensureCollections(client: SynapseOneClient): Promise<void> {
  for (const name of Object.values(COLLECTIONS)) {
    try {
      await client.base.getCollection(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await client.base.createCollection({ name, description: `SynapseDX capability ${name}` });
    }
  }
}

export function documentData<T>(document: any): T {
  return (document?.data ?? document?.object ?? document) as T;
}

export function pageFromDocuments<T>(documents: any[], limit: number, offset: number) {
  const items = documents.map((doc) => ({
    id: doc.id,
    data: documentData<T>(doc),
    version: doc.version,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }));
  return { items, total: items.length, limit, offset, nextCursor: null };
}

export async function emitCapabilityEvent(
  client: SynapseOneClient,
  event: Record<string, unknown>,
): Promise<void> {
  // Queue is at-least-once. The event id is the idempotency/dedupe key for
  // downstream consumers; no Tier-3 process gets a private queue connection.
  try {
    await client.queue.createQueue(EVENTS_QUEUE, { maxAttempts: 8, visibilityTimeoutSeconds: 30 });
  } catch (error) {
    // A concurrent creator returns a conflict. Other failures must propagate.
    if (!(error instanceof SynapseOneError && (error.status === 400 || error.status === 409))) throw error;
  }
  await client.queue.publish(EVENTS_QUEUE, event, {
    id: String(event.eventId),
    dedupeKey: String(event.eventId),
  });
}

