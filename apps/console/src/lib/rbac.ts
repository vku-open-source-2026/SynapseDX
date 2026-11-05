// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Role/permission helpers shared by the console and its unit tests. */

export interface ManagementContext {
  user?: { id: string; email?: string; displayName?: string };
  tenant?: string;
  account?: string;
  org?: string;
  roles?: string[];
  permissions?: string[];
  auth?: { kind?: string; scopes?: string[] };
}

export const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrator',
  operator: 'Operator',
  moderator: 'Moderator',
  manager: 'Manager',
  viewer: 'Viewer',
};

const ROLE_ORDER = ['admin', 'moderator', 'operator', 'manager', 'viewer'];

export function hasRole(context: ManagementContext | null, role: string): boolean {
  return Boolean(context?.roles?.includes(role));
}

export function can(context: ManagementContext | null, permission: string): boolean {
  return Boolean(context?.permissions?.includes(permission));
}

export function primaryRole(context: ManagementContext | null): string | null {
  if (!context?.roles) return null;
  return ROLE_ORDER.find((role) => context.roles!.includes(role)) ?? null;
}

export function roleLabel(context: ManagementContext | null): string {
  const role = primaryRole(context);
  return role ? ROLE_LABELS[role] : 'Public';
}

export type ConsoleView =
  | 'overview'
  | 'datasets'
  | 'records'
  | 'moderation'
  | 'approvals'
  | 'modules'
  | 'team'
  | 'events'
  | 'audit'
  | 'settings';

export interface NavItem {
  view: ConsoleView;
  label: string;
  /** lucide-react icon name as rendered by the sidebar. */
  icon: 'dashboard' | 'datasets' | 'records' | 'moderation' | 'modules' | 'approvals' | 'team' | 'events' | 'audit' | 'settings';
}

/**
 * Navigation is additive and permission-driven. Public visitors only see the
 * catalog; authenticated management users see exactly the lanes they can use.
 */
export function navigationFor(context: ManagementContext | null): NavItem[] {
  const items: NavItem[] = [
    { view: 'overview', label: 'Overview', icon: 'dashboard' },
    { view: 'datasets', label: 'Datasets', icon: 'datasets' },
  ];
  if (can(context, 'records:read')) items.push({ view: 'records', label: 'Records', icon: 'records' });
  if (can(context, 'records:read') || can(context, 'datasets:read')) {
    items.push({ view: 'modules', label: 'Modules', icon: 'modules' });
  }
  if (can(context, 'moderation:read')) items.push({ view: 'moderation', label: 'Moderation', icon: 'moderation' });
  if (can(context, 'approvals:read')) items.push({ view: 'approvals', label: 'Approvals', icon: 'approvals' });
  if (can(context, 'users:read')) items.push({ view: 'team', label: 'Team', icon: 'team' });
  if (can(context, 'events:read')) items.push({ view: 'events', label: 'Events', icon: 'events' });
  if (can(context, 'audit:read')) items.push({ view: 'audit', label: 'Audit & usage', icon: 'audit' });
  if (can(context, 'settings:read') || can(context, 'settings:write')) {
    items.push({ view: 'settings', label: 'Settings', icon: 'settings' });
  }
  return items;
}

export function canOpenView(context: ManagementContext | null, view: ConsoleView): boolean {
  return navigationFor(context).some((item) => item.view === view);
}
