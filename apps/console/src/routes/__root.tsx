// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createRootRoute, Outlet, Link } from '@tanstack/react-router';
import { useI18n } from '../lib/i18n-context';
import { PRIMARY_BTN } from '../components/public-styles';

function RootError({ error }: { error?: unknown }) {
  const { m } = useI18n();
  const message = error instanceof Error ? error.message : m.errors.fallback;
  return (
    <div className="flex h-full items-center justify-center bg-dx-bg p-6">
      <div className="max-w-md rounded-2xl border border-dx-line bg-dx-surface p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-dx-fg">{m.errors.title}</h1>
        <p className="mt-2 text-sm text-dx-muted">{message}</p>
        <Link to="/" className={`${PRIMARY_BTN} mt-5 text-sm`}>
          {m.errors.back}
        </Link>
      </div>
    </div>
  );
}

function RootNotFound() {
  const { m } = useI18n();
  return (
    <div className="flex h-full items-center justify-center bg-dx-bg p-6 text-center">
      <div>
        <p className="font-mono text-sm text-dx-muted">404</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-dx-fg">{m.errors.notFound}</h1>
        <Link to="/" className="mt-3 inline-block text-sm font-semibold text-dx-accent hover:underline">
          {m.errors.back}
        </Link>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  component: () => <Outlet />,
  errorComponent: RootError,
  notFoundComponent: RootNotFound,
});
