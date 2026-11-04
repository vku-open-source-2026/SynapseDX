// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Tenant-scoped Tier-2 management settings stored in Tier-1 Base. */
import { SynapseOneClient, SynapseOneError } from '@synapseone/sdk';
import { COLLECTIONS, getDocumentOrNull } from './platform';

export interface ManagementSettings {
  requireReview: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

const DEFAULT_SETTINGS: ManagementSettings = { requireReview: false };

function documentId(tenant: string): string {
  return `settings:${tenant}`.replace(/[^A-Za-z0-9_.:@-]/g, '_').slice(0, 256);
}

export async function loadManagementSettings(client: SynapseOneClient, tenant: string): Promise<ManagementSettings> {
  const document = await getDocumentOrNull<ManagementSettings>(client, COLLECTIONS.settings, documentId(tenant));
  if (!document) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...document.data };
}

export async function saveManagementSettings(
  client: SynapseOneClient,
  tenant: string,
  settings: ManagementSettings,
): Promise<ManagementSettings> {
  const id = documentId(tenant);
  const document = await getDocumentOrNull<ManagementSettings>(client, COLLECTIONS.settings, id);
  const next: ManagementSettings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    updatedAt: new Date().toISOString(),
  };
  if (!document) {
    await client.base.createDocument(COLLECTIONS.settings, { id, data: next as unknown as Record<string, unknown> });
    return next;
  }
  const saved = await client.base.updateDocument(COLLECTIONS.settings, id, {
    data: next as unknown as Record<string, unknown>,
    ifVersion: document.version,
  }).catch((error: unknown) => {
    if (error instanceof SynapseOneError && error.status === 409) {
      throw Object.assign(new Error('settings were modified by another request'), { status: 409, code: 'version_conflict' });
    }
    throw error;
  });
  return saved.data as unknown as ManagementSettings;
}
