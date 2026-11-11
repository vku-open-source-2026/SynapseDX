// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { Footer } from './Footer';
import { Toaster } from './Toaster';
import { Skeleton, Button } from './ui';
import { useI18n } from '../lib/i18n-context';

/** Protected console shell: session gate + admin layout + outbox health. */
export function AdminLayout() {
  const location = useLocation();
  const { m } = useI18n();
  const { session, context, status, fetchContext } = useAuthStore();
  const [checkedAt, setCheckedAt] = useState(() => new Date());

  const didFetch = useRef(false);
  useEffect(() => {
    if (!didFetch.current) {
      didFetch.current = true;
      void fetchContext();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session === null]);

  useEffect(() => {
    const id = window.setInterval(() => setCheckedAt(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (!session) {
    return <Navigate to="/login" search={{ redirect: location.pathname }} />;
  }

  if (status === 'unavailable') {
    return (
      <div className="flex h-full items-center justify-center bg-dx-bg p-6">
        <div className="max-w-md rounded-2xl border border-dx-line bg-dx-surface p-6 text-center shadow-sm">
          <h1 className="text-xl font-semibold tracking-tight text-dx-fg">{m.shell.unavailableTitle}</h1>
          <p className="mt-2 text-sm leading-6 text-dx-muted">{m.shell.unavailableText}</p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="primary" onClick={() => void fetchContext()}>{m.shell.retry}</Button>
            <Button variant="ghost" onClick={() => void useAuthStore.getState().logout()}>{m.shell.signOut}</Button>
          </div>
        </div>
      </div>
    );
  }

  const ready = status === 'ready' && Boolean(context);

  return (
    <div className="flex h-full overflow-hidden bg-dx-bg text-dx-fg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar context={ready ? context : null} />
        <main id="admin-main" className="min-w-0 flex-1 overflow-y-auto">
          {ready ? (
            <div className="mx-auto w-full max-w-[1400px] px-5 py-6">
              <Outlet />
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[1400px] space-y-4 px-5 py-6">
              <Skeleton className="h-36 w-full" />
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-24 w-full" />
                ))}
              </div>
              <Skeleton className="h-64 w-full" />
            </div>
          )}
        </main>
        <Footer checkedAt={checkedAt} />
      </div>
      <Toaster />
    </div>
  );
}
