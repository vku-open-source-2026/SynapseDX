// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Link } from '@tanstack/react-router';
import { Boxes } from 'lucide-react';

/** Public top navigation shared by the catalog landing and the login page. */
export function PublicHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-200/70 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-cyan-400 text-white">
            <Boxes size={19} strokeWidth={2.2} />
          </span>
          <span className="leading-tight">
            <span className="block text-lg font-bold tracking-tight text-slate-900">SynapseDX</span>
            <span className="block text-[9px] font-semibold uppercase tracking-[0.25em] text-slate-400">
              Capability control plane
            </span>
          </span>
        </Link>
        <nav className="flex items-center gap-2">
          <a
            href="https://github.com/vku-open-source-2026/SynapseDX/blob/main/docs/API.md"
            target="_blank"
            rel="noreferrer"
            className="hidden rounded-lg px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900 md:block"
          >
            API reference
          </a>
          <Link
            to="/login"
            className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
          >
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}
