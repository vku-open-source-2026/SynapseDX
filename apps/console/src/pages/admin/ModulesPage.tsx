// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, LayoutTemplate, Search } from 'lucide-react';
import { MODULE_CATALOG, CapabilityModule } from '../../components/workspaces/CapabilityModule';
import { Button, Card } from '../../components/ui';
export const MODULE_TABS = MODULE_CATALOG;
export type ModuleTabId = (typeof MODULE_CATALOG)[number]['id'];
export function ModulesPage() {
  const [active, setActive] = useState(window.location.hash.slice(1));
  const [search, setSearch] = useState('');
  const [targetApp,setTargetApp] = useState('city');
  useEffect(() => {
    const change = () => setActive(window.location.hash.slice(1));
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const entry = MODULE_CATALOG.find((item) => item.id === active);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-500">
            Your organization · Capability catalog
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-dx-fg">
            H-D-P-I workspace
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-dx-muted">
            Your existing tools, ready to open or compose into a new page.
          </p>
        </div>
        <a
          href={`/workspace?product=${targetApp}&page=${targetApp}-common-workspace`}
          className="flex items-center gap-2 text-sm font-semibold text-indigo-600"
        >
          Common workspace <ArrowUpRight size={16} />
        </a>
      </div>
      <label className="flex items-center gap-3 text-sm text-dx-muted">Build for app
        <select aria-label="Target app" className="rounded-lg border border-dx-line bg-dx-surface px-3 py-2" value={targetApp} onChange={event=>setTargetApp(event.target.value)}><option value="city">SynapseCity</option><option value="sos">SynapseCity SOS</option></select>
        <span className="text-xs">Common workspace membership and data stay inside the selected app.</span>
      </label>
      {entry ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="ghost"
              onClick={() => {
                window.location.hash = '';
              }}
            >
              <ArrowLeft size={15} /> Catalog
            </Button>
            <a
              href={`/admin/workspaces?product=${targetApp}#template=${entry.id}`}
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
            >
              <LayoutTemplate size={15} /> Use in page builder
            </a>
          </div>
          <nav
            aria-label="H-D-P-I capabilities"
            className="flex gap-1 overflow-x-auto rounded-xl border border-dx-line bg-dx-surface p-2"
          >
            {MODULE_CATALOG.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                data-action="module-tab"
                data-id={item.id}
                aria-current={entry.id === item.id ? 'page' : undefined}
                className={
                  entry.id === item.id
                    ? 'shrink-0 rounded-lg bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
                    : 'shrink-0 rounded-lg px-3 py-2 text-xs text-dx-muted hover:bg-dx-subtle'
                }
              >
                {item.label}
              </a>
            ))}
          </nav>
          <Card className="p-5">
            <CapabilityModule module={entry.id} />
          </Card>
        </>
      ) : (
        <>
          <label className="flex max-w-lg items-center gap-3 rounded-xl border border-dx-line bg-dx-surface px-4 py-3 text-dx-muted">
            <Search size={17} />
            <input
              aria-label="Find capability"
              className="w-full bg-transparent text-sm outline-none"
              placeholder="Find a capability…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {['H', 'D', 'P', 'I'].map((lane) => (
            <section key={lane}>
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-100 text-xs font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                  {lane === 'Shared' ? '◇' : lane}
                </span>
                <h2 className="text-sm font-semibold">
                  {
                    (
                      {
                        Shared: 'Shared tools',
                        H: 'Human & collaboration',
                        D: 'Data & insights',
                        P: 'People & process',
                        I: 'Intelligence',
                      } as Record<string, string>
                    )[lane]
                  }
                </h2>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {MODULE_CATALOG.filter(
                  (item) =>
                    item.lane === lane &&
                    `${item.label} ${item.description}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                ).map((item) => (
                  <Card
                    key={item.id}
                    className="group p-5 transition hover:border-indigo-300 hover:shadow-md"
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-dx-fg">{item.label}</h3>
                      <ArrowUpRight
                        size={16}
                        className="text-dx-muted group-hover:text-indigo-500"
                      />
                    </div>
                    <p className="mt-2 min-h-10 text-sm text-dx-muted">{item.description}</p>
                    <div className="mt-4 flex items-center justify-between border-t border-dx-line pt-3">
                      <a
                        href={`#${item.id}`}
                        data-action="module-tab"
                        data-id={item.id}
                        className="text-xs font-semibold text-indigo-600"
                      >
                        Open capability
                      </a>
                      <a
                        href={`/admin/workspaces?product=${targetApp}#template=${item.id}`}
                        className="text-xs text-dx-muted hover:text-indigo-500"
                      >
                        Use in builder →
                      </a>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
