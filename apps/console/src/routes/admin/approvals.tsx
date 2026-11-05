// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { ApprovalsPage } from '../../pages/admin/ApprovalsPage';

export const Route = createFileRoute('/admin/approvals')({
  component: ApprovalsPage,
});
