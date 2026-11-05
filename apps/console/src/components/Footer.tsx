// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

/** Shared console footer: product, license and last-checked stamp. */
export function Footer({ checkedAt }: { checkedAt?: Date }) {
  return (
    <footer className="border-t border-slate-200 bg-white px-5 py-3 text-[11px] text-slate-400">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-2">
        <span>SynapseDX · VKU.VIC · Apache-2.0</span>
        <span>
          Boundary checked <time dateTime={(checkedAt ?? new Date()).toISOString()}>{(checkedAt ?? new Date()).toLocaleTimeString()}</time>
          {' · '}
          <a className="hover:text-slate-600 underline underline-offset-2" href="https://synapsedx.sbs/health" target="_blank" rel="noreferrer">
            /health
          </a>
        </span>
      </div>
    </footer>
  );
}
