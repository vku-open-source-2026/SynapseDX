// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Where an authenticated person should land.
 *
 * A verified organization administrator / management role opens the control
 * plane (`/admin`); every other member (technician, volunteer, responder,
 * operator without the management console role) opens the Tier-2 workspace.
 * The decision is a navigation convenience only: the capability service still
 * enforces every read and mutation on the server.
 */
import type { ManagementContext } from './rbac';

/** Roles that may open the management console shell. */
export const MANAGEMENT_ROLES = ['admin', 'manager', 'operator', 'moderator'] as const;

export function hasManagementAccess(context: ManagementContext | null): boolean {
  return context?.isOrganizationAdmin === true;
}

/** Default destination after sign-in for the verified context. */
export function landingPath(context: ManagementContext | null): '/admin' | '/workspace' {
  return hasManagementAccess(context) ? '/admin' : '/workspace';
}

/**
 * Only same-origin absolute paths are accepted. Protocol-relative and
 * backslash variants are rejected so an attacker cannot turn a login link into
 * an open redirect.
 */
export function safeRedirectPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return null;
  if (candidate === '/login' || candidate.startsWith('/login?') || candidate.startsWith('/login/')) return null;
  return candidate;
}

/**
 * Resolve the post-login target: an explicit same-origin redirect only when
 * the verified context may open it; otherwise the role-appropriate landing.
 */
export function resolveLoginTarget(rawRedirect: unknown, context: ManagementContext | null): string {
  const landing = landingPath(context);
  const redirect = safeRedirectPath(rawRedirect);
  if (!redirect) return landing;
  if (!hasManagementAccess(context) && (redirect === '/admin' || redirect.startsWith('/admin/'))) {
    return landing;
  }
  return redirect;
}
