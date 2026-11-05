// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { AuditPage } from '../../pages/admin/AuditPage';

export const Route = createFileRoute('/admin/audit')({
  component: AuditPage,
});
