// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** H-P-D-I capability lanes, one tab each; each lane is permission-guarded by the server. */
import { useState } from 'react';
import { Card } from '../../components/ui';
import { InboxModule } from './modules/InboxModule';
import { WorkspaceModule } from './modules/WorkspaceModule';
import { PeopleModule } from './modules/PeopleModule';
import { ProjectsModule } from './modules/ProjectsModule';
import { FormsModule } from './modules/FormsModule';
import { ReportsModule } from './modules/ReportsModule';
import { QualityModule } from './modules/QualityModule';
import { OcrModule } from './modules/OcrModule';
import { AgentsModule } from './modules/AgentsModule';
import { AssistantModule } from './modules/AssistantModule';
import { cn } from '../../lib/utils';

export const MODULE_TABS = [
  { id: 'inbox', label: 'Inbox', component: InboxModule },
  { id: 'workspace', label: 'Workspace', component: WorkspaceModule },
  { id: 'people', label: 'People & KPIs', component: PeopleModule },
  { id: 'projects', label: 'Projects', component: ProjectsModule },
  { id: 'forms', label: 'Forms & process', component: FormsModule },
  { id: 'reports', label: 'Reports', component: ReportsModule },
  { id: 'quality', label: 'Data quality', component: QualityModule },
  { id: 'ocr', label: 'OCR queue', component: OcrModule },
  { id: 'agents', label: 'Agents', component: AgentsModule },
  { id: 'assistant', label: 'Assistant', component: AssistantModule },
] as const;

export type ModuleTabId = (typeof MODULE_TABS)[number]['id'];
const TAB_IDS = new Set<string>(MODULE_TABS.map((tab) => tab.id));

export function ModulesPage() {
  const [tab, setTab] = useState<ModuleTabId>('inbox');
  const active = TAB_IDS.has(tab) ? tab : 'inbox';
  const Active = MODULE_TABS.find((item) => item.id === active)!.component;

  return (
    <Card className="p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">H · P · D · I CAPABILITIES</p>
      <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-slate-900">Business modules</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-500">
        H-P-D-I modules share tenant scoping, audit and Tier-1 persistence. Each lane only loads what your role can open.
      </p>
      <div className="mt-4 flex flex-wrap gap-1.5 rounded-2xl bg-slate-100 p-1.5" role="tablist" aria-label="Business modules">
        {MODULE_TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={item.id === active}
            data-action="module-tab"
            data-id={item.id}
            onClick={() => setTab(item.id)}
            className={cn(
              'rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors',
              item.id === active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="mt-5" role="tabpanel">
        <Active />
      </div>
    </Card>
  );
}
