// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute, redirect } from '@tanstack/react-router';
import { LoginPage } from '../pages/LoginPage';
import { api } from '../lib/api';
import { clearSession, loadSession } from '../lib/httpClient';
import { resolveLoginTarget } from '../lib/landing';
import type { ManagementContext } from '../lib/rbac';

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  beforeLoad: async ({ search }) => {
    // A stored session must never be shown a second login form. Resolve the
    // verified context before the route renders; if the credential is no
    // longer valid, clear it and continue to the form.
    if (!loadSession()) return;
    let context: ManagementContext | null = null;
    try {
      context = await api.get<ManagementContext>('/v1/capabilities/management/context');
    } catch (error) {
      if ((error as { status?: number }).status === 401) clearSession();
      return;
    }
    if (!context) return;
    throw redirect({ to: resolveLoginTarget(search.redirect, context) as never, replace: true });
  },
  component: LoginPage,
});
