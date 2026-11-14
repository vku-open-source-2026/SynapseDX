// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useEffect } from 'react';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { PublicHomePage } from '../pages/PublicHomePage';
import { useAuthStore } from '../stores/authStore';
import { landingPath } from '../lib/landing';
import { Skeleton } from '../components/ui';

function RootIndex() {
  const session = useAuthStore((state) => state.session);
  const context = useAuthStore((state) => state.context);
  const status = useAuthStore((state) => state.status);
  const fetchContext = useAuthStore((state) => state.fetchContext);

  useEffect(() => {
    if (session && !context && status === 'idle') {
      void fetchContext();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session === null]);

  if (!session) return <PublicHomePage />;

  // A signed-in visitor never sees the anonymous catalog first: continue to
  // the management console or the member workspace, decided by the verified
  // server context (never by a client-provided role).
  if (context) return <Navigate to={landingPath(context)} replace />;

  if (status === 'unavailable') {
    return (
      <div className="flex h-full items-center justify-center bg-dx-bg p-6">
        <div className="max-w-md rounded-2xl border border-dx-line bg-dx-surface p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-dx-fg">The capability service is unreachable</h1>
          <p className="mt-2 text-sm text-dx-muted">
            Your saved session was kept. Retry the verification or open the public catalog again.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              className="rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2 text-sm font-semibold text-white"
              onClick={() => void fetchContext()}
            >
              Retry
            </button>
            <button
              type="button"
              className="rounded-xl border border-dx-line px-4 py-2 text-sm font-semibold text-dx-fg"
              onClick={() => void useAuthStore.getState().logout()}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-16">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export const Route = createFileRoute('/')({
  component: RootIndex,
});
