// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InboxModule } from '../../pages/admin/modules/InboxModule';
import { WorkspaceModule } from '../../pages/admin/modules/WorkspaceModule';
import { PeopleModule } from '../../pages/admin/modules/PeopleModule';
import { ProjectsModule } from '../../pages/admin/modules/ProjectsModule';
import { TasksModule } from '../../pages/admin/modules/TasksModule';
import { FormsModule } from '../../pages/admin/modules/FormsModule';
import { ReportsModule } from '../../pages/admin/modules/ReportsModule';
import { QualityModule } from '../../pages/admin/modules/QualityModule';
import { OcrModule } from '../../pages/admin/modules/OcrModule';
import { AgentsModule } from '../../pages/admin/modules/AgentsModule';
import { AssistantModule } from '../../pages/admin/modules/AssistantModule';

export const MODULE_CATALOG = [
  {
    id: 'inbox',
    label: 'Inbox',
    lane: 'H',
    description: 'Messages and team collaboration',
    component: InboxModule,
  },
  {
    id: 'workspace',
    label: 'Workspace & wiki',
    lane: 'H',
    description: 'Knowledge, pages and PARA folders',
    component: WorkspaceModule,
  },
  {
    id: 'people',
    label: 'People & KPIs',
    lane: 'P',
    description: 'People, goals and performance',
    component: PeopleModule,
  },
  {
    id: 'projects',
    label: 'Projects',
    lane: 'P',
    description: 'Portfolio, milestones and capacity',
    component: ProjectsModule,
  },
  {
    id: 'tasks',
    label: 'Tasks',
    lane: 'H',
    description: 'Your app team’s task board',
    component: TasksModule,
  },
  {
    id: 'forms',
    label: 'Forms & process',
    lane: 'P',
    description: 'Forms, approvals and processes',
    component: FormsModule,
  },
  {
    id: 'reports',
    label: 'Reports',
    lane: 'D',
    description: 'Reports and business intelligence',
    component: ReportsModule,
  },
  {
    id: 'quality',
    label: 'Data quality',
    lane: 'D',
    description: 'Validation and quality rules',
    component: QualityModule,
  },
  {
    id: 'ocr',
    label: 'OCR queue',
    lane: 'D',
    description: 'Document extraction and review',
    component: OcrModule,
  },
  {
    id: 'agents',
    label: 'Agents',
    lane: 'I',
    description: 'Manage intelligent agents',
    component: AgentsModule,
  },
  {
    id: 'assistant',
    label: 'Assistant',
    lane: 'I',
    description: 'Ask questions and find knowledge',
    component: AssistantModule,
  },
] as const;
export function CapabilityModule({ module, product = 'city' }: { module: string; product?: string }) {
  const client = useMemo(() => new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}}), [product]);
  const entry = MODULE_CATALOG.find((item) => item.id === module);
  if (!entry) return <p role="alert">This capability is unavailable.</p>;
  const Component = entry.component;
  return <QueryClientProvider client={client}><Component /></QueryClientProvider>;
}
