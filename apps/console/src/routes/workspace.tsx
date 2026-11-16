// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute, redirect } from '@tanstack/react-router';
import { loadSession } from '../lib/httpClient';
import { WorkspacePage } from '../pages/WorkspacePage';
import { CAPABILITY_MODULES, isWorkspaceProduct } from '../lib/workspaces';
export const Route = createFileRoute('/workspace')({
  beforeLoad: ({ location }) => {
    if (!loadSession()) {
      throw redirect({ to: '/login', search: { redirect: location.href }, replace: true });
    }
  },
  validateSearch: (search: Record<string, unknown>) => ({
    product: isWorkspaceProduct(search.product) ? search.product : 'dx' as const,
    page: typeof search.page === 'string' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(search.page) ? search.page : undefined,
    section:typeof search.section==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(search.section)?search.section:undefined,
    module: typeof search.module === 'string' && (CAPABILITY_MODULES as readonly string[]).includes(search.module) ? search.module : undefined,
  }),
  component: WorkspacePage,
});
