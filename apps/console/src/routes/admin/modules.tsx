// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { ModulesPage } from '../../pages/admin/ModulesPage';

export const Route = createFileRoute('/admin/modules')({
  component: ModulesPage,
});
