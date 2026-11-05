// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { DatasetsPage } from '../../pages/admin/DatasetsPage';

export const Route = createFileRoute('/admin/datasets')({
  validateSearch: (search: Record<string, unknown>): { new?: string } =>
    search.new === '1' ? { new: '1' } : {},
  component: DatasetsPage,
});
