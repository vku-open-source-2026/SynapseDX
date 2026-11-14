// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { WorkflowsPage } from '../../pages/admin/WorkflowsPage';

export const Route = createFileRoute('/admin/workflows')({
  component: WorkflowsPage,
});
