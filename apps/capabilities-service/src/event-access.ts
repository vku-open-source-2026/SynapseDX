// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Tenant/ACL gate for capability event feeds and SSE relays.
 *
 * Events are persisted in one global Tier-1 stream. Consumers must never see
 * another tenant's dataset/record activity: an event is visible only when it
 * carries the caller's own tenant, or its dataset is readable by the caller
 * (public published projections included). Dataset lookups are cached for one
 * feed poll / SSE connection so a burst of record events is not an N+1 query.
 */
import { SynapseOneClient } from '@synapseone/sdk';
import { Caller, canAccessDataset, isAdmin } from './auth';
import { loadDataset } from './publication';

export interface EventScope {
  datasetId?: unknown;
  tenant?: unknown;
  type?: unknown;
}

export type EventAccessChecker = (event: unknown) => Promise<boolean>;

export function createEventAccessChecker(
  client: SynapseOneClient,
  caller: Caller,
  cache: Map<string, boolean> = new Map(),
): EventAccessChecker {
  const principal = caller.principal;
  if (!caller.authenticated || !principal) return async () => false;
  if (isAdmin(principal)) return async () => true;
  const callerTenant = principal.sourceTenantKey || principal.tenantKey;

  return async (payload: unknown): Promise<boolean> => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const event = payload as EventScope;
    if (typeof event.tenant === 'string' && event.tenant) {
      if (event.tenant === callerTenant) return true;
    }
    const datasetId = typeof event.datasetId === 'string' ? event.datasetId : '';
    if (!datasetId) return false;
    if (cache.has(datasetId)) return cache.get(datasetId) === true;
    let allowed = false;
    try {
      const found = await loadDataset(client, datasetId);
      allowed = !!found && canAccessDataset(found.data, caller);
    } catch {
      allowed = false;
    }
    cache.set(datasetId, allowed);
    return allowed;
  };
}
