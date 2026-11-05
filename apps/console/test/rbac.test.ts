// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';
import {
  can,
  canOpenView,
  navigationFor,
  primaryRole,
  roleLabel,
  type ManagementContext,
} from '../src/lib/rbac';

const operator: ManagementContext = {
  roles: ['operator', 'manager'],
  permissions: ['summary:read', 'datasets:read', 'datasets:write', 'records:read', 'records:write', 'events:read', 'events:flush', 'audit:read', 'settings:read'],
};
const moderator: ManagementContext = {
  roles: ['moderator', 'manager'],
  permissions: ['summary:read', 'datasets:read', 'records:read', 'moderation:read', 'moderation:write', 'audit:read'],
};
const admin: ManagementContext = {
  roles: ['admin'],
  permissions: [
    'summary:read', 'datasets:read', 'datasets:write', 'records:read', 'records:write',
    'moderation:read', 'moderation:write', 'events:read', 'events:flush', 'audit:read',
    'users:read', 'settings:write', 'approvals:read', 'approvals:write',
  ],
};

describe('rbac helpers', () => {
  it('navigation is permission-driven and public visitors only see the catalog', () => {
    expect(navigationFor(null).map((item) => item.view)).toEqual(['overview', 'datasets']);
    expect(navigationFor(operator).map((item) => item.view)).toEqual(['overview', 'datasets', 'records', 'modules', 'events', 'audit', 'settings']);
    expect(navigationFor(moderator).map((item) => item.view)).toEqual(['overview', 'datasets', 'records', 'modules', 'moderation', 'audit']);
    expect(navigationFor(admin).map((item) => item.view)).toEqual([
      'overview', 'datasets', 'records', 'modules', 'moderation', 'approvals', 'team', 'events', 'audit', 'settings',
    ]);
    expect(canOpenView(operator, 'moderation')).toBe(false);
    expect(canOpenView(moderator, 'moderation')).toBe(true);
    expect(can(admin, 'users:read')).toBe(true);
    expect(can(operator, 'moderation:write')).toBe(false);
  });

  it('role labels prefer the strongest management role', () => {
    expect(primaryRole(admin)).toBe('admin');
    expect(primaryRole(moderator)).toBe('moderator');
    expect(primaryRole(operator)).toBe('operator');
    expect(primaryRole(null)).toBeNull();
    expect(roleLabel(admin)).toBe('Administrator');
    expect(roleLabel(null)).toBe('Public');
  });
});
