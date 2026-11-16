// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { WarehousePage } from '../../pages/admin/WarehousePage';

export const Route = createFileRoute('/admin/warehouse')({
  component: WarehousePage,
});
