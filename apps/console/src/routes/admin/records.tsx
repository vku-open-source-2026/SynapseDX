// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { RecordsPage } from '../../pages/admin/RecordsPage';

export const Route = createFileRoute('/admin/records')({
  validateSearch: (search: Record<string, unknown>): { dataset?: string } =>
    typeof search.dataset === 'string' && search.dataset ? { dataset: search.dataset } : {},
  component: RecordsPage,
});
