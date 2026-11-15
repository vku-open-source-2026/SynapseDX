// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { api } from '../lib/api';
import { hasManagementAccess } from '../lib/landing';
import type { ManagementContext } from '../lib/rbac';
import { loadSession } from '../lib/httpClient';
import { AdminLayout } from '../components/AdminLayout';
import { PRIMARY_BTN } from '../components/public-styles';

function AdminError({ error }: { error?: unknown }) {
  const message = error instanceof Error ? error.message : 'The management console could not render this page.';
  return (
    <div className="flex min-h-[60vh] items-center justify-center bg-dx-bg p-6">
      <div className="max-w-lg rounded-2xl border border-dx-line bg-dx-surface p-6 text-center shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-600">Console recovery</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-dx-fg">This page hit a render error</h1>
        <p className="mt-2 break-words text-sm leading-6 text-dx-muted">{message}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={() => window.location.reload()} className={PRIMARY_BTN}>
            Reload page
          </button>
          <Link to="/workspace" search={{ product: 'dx', page: undefined, section: undefined, module: undefined }} className="rounded-xl border border-dx-line px-4 py-2 text-sm font-semibold text-dx-fg">
            Open member workspace
          </Link>
          <Link to="/" className="rounded-xl border border-dx-line px-4 py-2 text-sm font-semibold text-dx-fg">
            Public catalog
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/admin')({
  beforeLoad: async ({ location }) => {
    if (!loadSession()) {
      throw redirect({ to: '/login', search: { redirect: location.href }, replace: true });
    }
    const context = await api.get<ManagementContext>('/v1/capabilities/management/context');
    if (!hasManagementAccess(context)) throw redirect({ to: '/workspace', search: { product: 'dx', page: undefined, section: undefined, module: undefined }, replace: true });
  },
  component: () => <AdminLayout />,
  errorComponent: AdminError,
});
