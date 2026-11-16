// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Application membership is independent of organization administration. */
import type { SynapseOneClient } from '@synapseone/sdk';
import type { CallerPrincipal } from './auth';
import { COLLECTIONS, getDocumentOrNull } from './platform';
import { CAPABILITY_MODULES, PRODUCT_ROLES, WORKSPACE_PRODUCTS, WorkspaceMemberRecord, WorkspaceProduct, workspaceDocId } from './workspace-plugins';
import { apiError } from './errors';

export type ProductRoles = Partial<Record<WorkspaceProduct, string[]>>;

export function parseProductRoles(value: unknown): ProductRoles {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw apiError(400, 'invalid_membership', 'productRoles must be an object keyed by app');
  const result: ProductRoles = {};
  for (const [key, roles] of Object.entries(value)) {
    if (!(WORKSPACE_PRODUCTS as readonly string[]).includes(key) || !Array.isArray(roles)) throw apiError(400, 'invalid_membership', 'unknown app or invalid roles');
    const product = key as WorkspaceProduct;
    if (roles.some(role => typeof role !== 'string' || !PRODUCT_ROLES[product].includes(role))) throw apiError(400, 'invalid_membership', 'role is not allowed for this app');
    result[product] = [...new Set(roles as string[])];
  }
  return result;
}

export function productRolesForMember(member: WorkspaceMemberRecord | null, principal: CallerPrincipal): ProductRoles {
  if (principal.isDxAdmin === true && principal.type === 'jwt' && (!principal.kind || principal.kind === 'user')) {
    return { city: member?.productRoles?.city?.length ? member.productRoles.city : ['admin'], sos: member?.productRoles?.sos?.length ? member.productRoles.sos : ['admin'] };
  }
  // Legacy global roles never grant access to an application. Migration must
  // establish explicit app membership from an operator grant/product profile.
  const grants = member?.productRoles ? parseProductRoles(member.productRoles) : {};
  delete grants.dx;
  return grants;
}

export async function workspaceAccess(client: SynapseOneClient, tenant: string, principal: CallerPrincipal): Promise<ProductRoles> {
  const member = await getDocumentOrNull<WorkspaceMemberRecord>(client, COLLECTIONS.workspaceMembers, workspaceDocId('ws-member', tenant, principal.subject));
  return productRolesForMember(member?.data?.tenant === tenant ? member.data : null, principal);
}

export function memberModules(principal: CallerPrincipal): readonly string[] {
  return principal.isDxAdmin === true ? CAPABILITY_MODULES : CAPABILITY_MODULES.filter(module => !['agents', 'quality', 'people'].includes(module));
}
