// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createRootRoute, Outlet, Link } from '@tanstack/react-router';

function RootError({ error }: { error?: unknown }) {
  const message = error instanceof Error ? error.message : 'Unexpected console error.';
  return (
    <div className="flex h-full items-center justify-center bg-[#f4f8fd] p-6">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">ERROR</p>
        <h1 className="mt-1 text-lg font-semibold text-slate-900">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-500">{message}</p>
        <Link
          to="/"
          className="mt-4 inline-block rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
        >
          Back to the catalog
        </Link>
      </div>
    </div>
  );
}

function RootNotFound() {
  return (
    <div className="flex h-full items-center justify-center bg-[#f4f8fd] p-6 text-center">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">404</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Page not found</h1>
        <Link to="/" className="mt-3 inline-block text-sm font-semibold text-blue-700 hover:underline">
          Back to the catalog
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
