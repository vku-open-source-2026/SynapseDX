// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Pure role/permission helpers shared by the console and its tests. */

export const ROLE_LABELS = {
  admin: 'Administrator',
  operator: 'Operator',
  moderator: 'Moderator',
  manager: 'Manager',
  viewer: 'Viewer',
};

const ROLE_ORDER = ['admin', 'moderator', 'operator', 'manager', 'viewer'];

export function hasRole(context, role) {
  return Boolean(context && Array.isArray(context.roles) && context.roles.includes(role));
}

export function hasAnyRole(context, roles) {
  return roles.some((role) => hasRole(context, role));
}

export function primaryRole(context) {
  if (!context || !Array.isArray(context.roles)) return null;
  return ROLE_ORDER.find((role) => context.roles.includes(role)) || null;
}

export function roleLabel(context) {
  const role = primaryRole(context);
  return role ? ROLE_LABELS[role] : 'Public';
}

export function can(context, permission) {
  return Boolean(context && Array.isArray(context.permissions) && context.permissions.includes(permission));
}

export function canAny(context, permissions) {
  return permissions.some((permission) => can(context, permission));
}

/**
 * Navigation is additive and permission-driven. Public visitors only see the
 * catalog; authenticated management users see exactly the lanes they can use.
 */
export function navigationFor(context) {
  const items = [
    { view: 'overview', label: 'Overview', icon: '⌂' },
    { view: 'datasets', label: 'Datasets', icon: '◈' },
  ];
  if (can(context, 'records:read')) items.push({ view: 'records', label: 'Records', icon: '▤' });
  if (can(context, 'moderation:read')) items.push({ view: 'moderation', label: 'Moderation', icon: '⚖' });
  if (can(context, 'events:read')) items.push({ view: 'events', label: 'Events', icon: '⌁' });
  if (can(context, 'audit:read')) items.push({ view: 'audit', label: 'Audit & usage', icon: '◎' });
  if (can(context, 'settings:read') || can(context, 'settings:write')) {
    items.push({ view: 'settings', label: 'Settings', icon: '⚙' });
  }
  return items;
}

export function canOpenView(context, view) {
  return navigationFor(context).some((item) => item.view === view);
}
