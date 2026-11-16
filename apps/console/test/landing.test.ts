// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';
import {
  hasManagementAccess,
  landingPath,
  resolveLoginTarget,
  safeRedirectPath,
} from '../src/lib/landing';
import type { ManagementContext } from '../src/lib/rbac';

function context(roles: string[]): ManagementContext {
  return { roles, permissions: [], isOrganizationAdmin: roles.includes('admin') };
}

describe('authenticated landing resolution', () => {
  it('reserves the control plane for verified organization admins', () => {
    expect(hasManagementAccess(context(['admin']))).toBe(true);
    expect(hasManagementAccess({roles:['admin'],permissions:['*']})).toBe(false);
    expect(landingPath(context(['manager']))).toBe('/workspace');
    expect(landingPath(context(['operator']))).toBe('/workspace');
    expect(landingPath(context(['moderator']))).toBe('/workspace');
  });

  it('sends ordinary members and volunteers to the member workspace', () => {
    expect(hasManagementAccess(context(['viewer']))).toBe(false);
    expect(landingPath(context(['viewer']))).toBe('/workspace');
    expect(landingPath(null)).toBe('/workspace');
  });

  it('accepts only same-origin redirect paths', () => {
    expect(safeRedirectPath('/workspace')).toBe('/workspace');
    expect(safeRedirectPath('https://evil.example')).toBeNull();
    expect(safeRedirectPath('//evil.example')).toBeNull();
    expect(safeRedirectPath('/\\evil.example')).toBeNull();
    expect(safeRedirectPath('/login?redirect=/admin')).toBeNull();
    expect(safeRedirectPath(undefined)).toBeNull();
  });

  it('does not let a member follow an admin redirect', () => {
    expect(resolveLoginTarget('/admin/workspaces', context(['viewer']))).toBe('/workspace');
    expect(resolveLoginTarget('/workspace', context(['admin']))).toBe('/workspace');
    expect(resolveLoginTarget('/admin/datasets', context(['admin']))).toBe('/admin/datasets');
    expect(resolveLoginTarget('/login', context(['admin']))).toBe('/admin');
  });
});
