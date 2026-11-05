// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

export function PublicFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs text-slate-400 sm:px-6">
        <span>SynapseDX · VKU.VIC · Apache-2.0</span>
        <div className="flex flex-wrap items-center gap-4">
          <a className="hover:text-slate-600" href="https://synapsedx.sbs/health" target="_blank" rel="noreferrer">
            /health
          </a>
          <a
            className="hover:text-slate-600"
            href="https://github.com/vku-open-source-2026/SynapseDX"
            target="_blank"
            rel="noreferrer"
          >
            Source code ↗
          </a>
        </div>
      </div>
    </footer>
  );
}
